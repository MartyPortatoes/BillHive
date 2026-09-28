'use strict';
const crypto=require('node:crypto');
const {Client,Transport,baseline}=require('../../public/check-review-client'),R=require('../../public/check-claim-review');
const fixture=require('../../test/fixtures/check-claim-review-parity.json').cases[0],copy=structuredClone,hash=v=>crypto.createHash('sha256').update(v).digest('hex');
const fail=code=>Object.assign(new Error(code),{code});
class Store {
  constructor(){this.rows=new Map();this.queue=Promise.resolve();this.fail=false;}
  transact(key,change){const next=this.queue.then(()=>{const value=change(copy(this.rows.get(key)));if(this.fail)throw new Error('storage failed');this.rows.set(key,copy(value));return copy(value);});this.queue=next.catch(()=>{});return next;}
}
function server(){const token='abcdefghijklmnopqrstuvwxyz';return {
  owner:{protocolVersion:1,userId:'owner',serverInstanceId:'server',householdId:'household',revision:1,state:{people:[],checks:{checks:[copy(fixture.check)]},settings:{currencyCode:'USD'},futureState:{kept:true}},monthly:{'2026-09':{totals:{rent:0}}}},
  shareRevision:1,claims:[{claimerName:'Alex',claimantId:'a'.repeat(64),itemIds:['meal'],claimedAt:'2026-09-27T12:00:00.000Z'}],token,calls:[],receipts:new Map(),lose:false,
  async load(){return {owner:copy(this.owner),sharing:{protocolVersion:1,...Object.fromEntries(['userId','serverInstanceId','householdId','revision'].map(k=>[k,this.owner[k]])),checkId:'dinner',checkExists:true,isCompleted:false,revisionPreconditionsRequired:true,shareRevision:this.shareRevision,shareUrl:'https://example.test/share/'+this.token,share:{token:this.token,shareId:hash(this.token),createdAt:123,claims:copy(this.claims)}},capabilities:{checkShareGuardProtocol:1,revisionPreconditionsRequired:true}};},
  async send(payload){this.calls.push(payload);const r=JSON.parse(payload);
    if(this.receipts.has(r.mutationId))return {...copy(this.owner),mutationId:r.mutationId,committedRevision:this.receipts.get(r.mutationId),replayed:true};
    if(r.baseRevision!==this.owner.revision)throw fail('REVISION_CONFLICT');
    if(r.checkSharePreconditions[0].shareRevision!==this.shareRevision)throw fail('CHECK_SHARE_CONFLICT');
    this.owner.state=copy(r.state);this.owner.monthly=copy(r.monthly);this.owner.revision++;this.receipts.set(r.mutationId,this.owner.revision);
    if(this.lose)throw new Error('lost response');return {...copy(this.owner),mutationId:r.mutationId,committedRevision:this.owner.revision,replayed:false};
  }
};}
async function ready(){const transport=server(),store=new Store(),client=new Client({owner:transport.owner,store,transport});await client.open();const fresh=await transport.load();await client.start(fresh);
  const source=client.row.drafts.dinner.baseline.sources[0],plan=copy(fixture.plan);plan.choices={[R.sourceId(source)]:{action:'APPLY',participantId:'c'}};await client.edit('dinner',plan);return {client,store,transport};}
async function prepare(client,transport){await client.prepare('dinner',await transport.load(),client.preview('dinner'),true);return client.row.pending.payload;}

module.exports={Client,Transport,baseline,R,fixture,copy,hash,fail,Store,server,ready,prepare};
