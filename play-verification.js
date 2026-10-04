'use strict';

// Optional merchant service, independent of personal household authentication.
// Android trusts only its build-pinned merchant origin/signing public key.
const crypto = require('node:crypto');
const PACKAGES = Object.freeze({
  'com.billhive.app': 'com.billhive.app.unlock',
  'com.billhive.selfhive': 'com.billhive.selfhive.unlock',
});
const failure = () => Object.assign(new Error('Play access could not be checked'), { code: 'PLAY_CHECK_UNAVAILABLE' });
const badRequest = () => Object.assign(new Error('Invalid Play verification request'), { code: 'PLAY_REQUEST_INVALID' });
function request(value) {
  if (!value || Array.isArray(value) || value.protocol !== 1 || !Object.hasOwn(PACKAGES,value.packageName) || PACKAGES[value.packageName] !== value.productId ||
      typeof value.purchaseToken !== 'string' || value.purchaseToken.length < 1 || value.purchaseToken.length > 16384 || /[\x00-\x1f\x7f]/.test(value.purchaseToken) ||
      typeof value.installation !== 'string' || typeof value.nonce !== 'string' ||
      !/^[A-Za-z0-9-]{16,80}$/.test(value.installation) || !/^[A-Za-z0-9-]{16,80}$/.test(value.nonce) ||
      Object.keys(value).some(key => !['protocol','packageName','productId','purchaseToken','installation','nonce'].includes(key))) throw badRequest();
  return value;
}
const tokenHash = token => crypto.createHash('sha256').update(token).digest('hex');
async function jsonBounded(response) {
  if (!response.ok) { await response.body?.cancel(); throw failure(); }
  const chunks = []; let count = 0;
  for await (const chunk of response.body) {
    count += chunk.length; if (count > 65536) throw failure(); chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

class GooglePlayPublisher {
  constructor(account, fetcher = fetch, clock = Date.now) {
    try {
      if (!account || typeof account.client_email !== 'string' || !account.client_email.endsWith('.gserviceaccount.com') ||
          account.token_uri !== 'https://oauth2.googleapis.com/token') throw failure();
      this.email = account.client_email; this.key = crypto.createPrivateKey(account.private_key);
      if (this.key.asymmetricKeyType !== 'rsa' || this.key.asymmetricKeyDetails.modulusLength < 2048) throw failure();
      this.fetch = fetcher; this.clock = clock; this.cached = null; this.refreshing = null;
    } catch { throw failure(); }
  }
  async accessToken() {
    if (this.cached && this.clock() < this.cached.until) return this.cached.token;
    if (this.refreshing) return this.refreshing;
    const obtain = async () => {
      const issued = Math.floor(this.clock() / 1000);
      const header = Buffer.from(JSON.stringify({alg:'RS256',typ:'JWT'})).toString('base64url');
      const claims = Buffer.from(JSON.stringify({iss:this.email,scope:'https://www.googleapis.com/auth/androidpublisher',
        aud:'https://oauth2.googleapis.com/token',iat:issued,exp:issued+3600})).toString('base64url');
      const bytes = `${header}.${claims}`;
      const assertion = `${bytes}.${crypto.sign('RSA-SHA256',Buffer.from(bytes),this.key).toString('base64url')}`;
      const result = await jsonBounded(await this.fetch('https://oauth2.googleapis.com/token', {
        method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),
        headers:{'Content-Type':'application/x-www-form-urlencoded'},
        body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion}).toString(),
      }));
      if (typeof result.access_token !== 'string' || !result.access_token || result.token_type !== 'Bearer' ||
          !Number.isInteger(result.expires_in) || result.expires_in < 120 || result.expires_in > 7200) throw failure();
      this.cached = {token:result.access_token,until:this.clock()+(result.expires_in-60)*1000};
      return result.access_token;
    };
    this.refreshing = obtain();
    try { return await this.refreshing; } finally { this.refreshing = null; }
  }
  async call(value, acknowledge = false) {
    request(value);
    const url = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/' +
      [value.packageName,'purchases','products',value.productId,'tokens',value.purchaseToken].map(encodeURIComponent).join('/') + (acknowledge ? ':acknowledge' : '');
    const response = await this.fetch(url, { method:acknowledge?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(10000),
      headers:{Authorization:`Bearer ${await this.accessToken()}`,...(acknowledge?{'Content-Type':'application/json'}:{})},
      ...(acknowledge?{body:'{}'}:{}),
    });
    if (!acknowledge) return jsonBounded(response);
    if (!response.ok) { await response.body?.cancel(); throw failure(); }
    await response.body?.cancel();
  }
  get(value) { return this.call(value); }
  acknowledge(value) { return this.call(value,true); }
}

class PlayVerifier {
  constructor({publisher,signingKey,db,clock=Date.now}) {
    this.publisher=publisher; this.clock=clock; this.key=crypto.createPrivateKey(signingKey);
    if (this.key.asymmetricKeyType !== 'rsa' || this.key.asymmetricKeyDetails.modulusLength < 2048) throw failure();
    this.active=new Map(); this.jobs=0;
    db.exec(`CREATE TABLE IF NOT EXISTS play_purchase_audit (
      token_hash TEXT PRIMARY KEY, package_name TEXT NOT NULL, product_id TEXT NOT NULL,
      state TEXT NOT NULL, acknowledged INTEGER NOT NULL, checked_at INTEGER NOT NULL
    )`);
    this.record=db.prepare('INSERT INTO play_purchase_audit VALUES (?,?,?,?,?,?) ON CONFLICT(token_hash) DO UPDATE SET state=excluded.state,acknowledged=excluded.acknowledged,checked_at=excluded.checked_at');
    this.existing=db.prepare('SELECT package_name,product_id FROM play_purchase_audit WHERE token_hash=?');
  }
  async verify(body) {
    const value=request(body); const hash=tokenHash(value.purchaseToken);
    if (this.jobs >= 128) throw failure();
    this.jobs++;
    const prior=this.active.get(hash) ?? Promise.resolve();
    const task=prior.catch(()=>{}).then(()=>this.checked(value,hash));
    this.active.set(hash,task);
    try {return await task;} finally {this.jobs--;if(this.active.get(hash)===task)this.active.delete(hash);}
  }
  validate(purchase,value) {
    if (!purchase || purchase.kind !== 'androidpublisher#productPurchase' || ![0,1,2].includes(purchase.purchaseState) ||
        ![0,1].includes(purchase.acknowledgementState) || purchase.consumptionState !== 0 ||
        (purchase.quantity ?? 1) !== 1 || (purchase.productId !== undefined && purchase.productId !== value.productId) ||
        (purchase.purchaseToken !== undefined && purchase.purchaseToken !== value.purchaseToken)) throw failure();
  }
  async checked(value,hash) {
    const existing=this.existing.get(hash);
    if (existing && (existing.package_name!==value.packageName || existing.product_id!==value.productId)) throw badRequest();
    let purchase=await this.publisher.get(value);this.validate(purchase,value);
    if (purchase.purchaseState===0 && purchase.acknowledgementState===0) {
      await this.publisher.acknowledge(value);
      // A successful/lost acknowledgement is not enough; read the resulting state back.
      purchase=await this.publisher.get(value);this.validate(purchase,value);
      if (purchase.purchaseState===0 && purchase.acknowledgementState!==1) throw failure();
    }
    const state=purchase.purchaseState===0?'ACTIVE':purchase.purchaseState===2?'PENDING':'REVOKED';
    const acknowledged=purchase.acknowledgementState===1;
    if (state==='ACTIVE' && !acknowledged) throw failure();
    const issuedAt=this.clock();
    if (!Number.isSafeInteger(issuedAt) || issuedAt <= 0 || issuedAt > Number.MAX_SAFE_INTEGER-86400000) throw failure();
    this.record.run(hash,value.packageName,value.productId,state,Number(acknowledged),issuedAt);
    const payload=Buffer.from(JSON.stringify({protocol:1,packageName:value.packageName,productId:value.productId,
      installation:value.installation,tokenHash:hash,nonce:value.nonce,state,acknowledged,issuedAt,expiresAt:issuedAt+86400000}));
    return {payload:payload.toString('base64url'),signature:crypto.sign('RSA-SHA256',payload,this.key).toString('base64url')};
  }
}

function configuredPlayVerifier(env,db) {
  if (env.PLAY_VERIFY_ENABLED !== '1') return null;
  try {
    return new PlayVerifier({db,publisher:new GooglePlayPublisher(JSON.parse(env.PLAY_PUBLISHER_ACCOUNT_JSON)),signingKey:env.PLAY_RECEIPT_SIGNING_KEY});
  } catch { throw new Error('Play merchant verification configuration is invalid'); }
}
function mountPlayVerification(app,verifier,limiter) {
  app.post('/api/play/verify',limiter,async(req,res)=>{
    res.setHeader('Cache-Control','no-store');
    if (!verifier) return res.status(503).json({code:'PLAY_CHECK_UNAVAILABLE'});
    try {return res.json(await verifier.verify(req.body));}
    catch(error) {return res.status(error.code==='PLAY_REQUEST_INVALID'?400:503).json({code:error.code==='PLAY_REQUEST_INVALID'?'PLAY_REQUEST_INVALID':'PLAY_CHECK_UNAVAILABLE'});}
  });
}
module.exports={PACKAGES,GooglePlayPublisher,PlayVerifier,configuredPlayVerifier,mountPlayVerification};
