/**
 * Builds the HTML and plain-text email for a bill summary.
 *
 * @param {object} opts
 * @param {string} opts.greeting      — e.g. "Hey babe," or "Hi Dad,"
 * @param {string} opts.personName    — display name
 * @param {string} opts.accentColor   — hex color for this person's highlights
 * @param {string} opts.monthLabel    — e.g. "March 2026"
 * @param {Array}  opts.bills         — [{ name, amount }]
 * @param {number} opts.total         — total owed
 * @param {string} opts.payMethod     — 'zelle' | 'venmo' | 'cashapp' | 'manual' | 'none'
 * @param {string} opts.payId         — zelle phone/email or venmo @handle
 * @param {string} opts.zelleUrl      — custom Zelle URL (overrides default enroll.zellepay.com link)
 * @param {string} opts.fromName      — sender display name
 */
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function safeUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? url : '';
  } catch { return ''; }
}

// Inline SVG hex logo mark — matches the iOS HexLogoMark
const HEX_LOGO = `<svg width="40" height="36" viewBox="0 0 40 36" xmlns="http://www.w3.org/2000/svg" style="display:block;">
  <polygon points="10,0 30,0 40,18 30,36 10,36 0,18" fill="#F5A800"/>
  <rect x="15" y="10" width="10" height="3" rx="1" fill="#0c0d0f"/>
  <rect x="12" y="16" width="16" height="3" rx="1" fill="#0c0d0f"/>
  <rect x="16" y="22" width="9" height="3" rx="1" fill="#0c0d0f"/>
</svg>`;

function buildEmailHtml(opts) {
  const {
    greeting, personName, accentColor: rawAccent = '#F5A800',
    monthLabel, bills, total, payMethod, payId, zelleUrl: customZelleUrl, fromName = 'BillHive',
  } = opts;

  // Validate accentColor is a safe hex value before embedding in HTML/CSS
  const accentColor = /^#[0-9A-Fa-f]{3,8}$/.test(rawAccent) ? rawAccent : '#F5A800';

  const accentBg     = accentColor + '22';
  const accentBorder = accentColor + '55';

  // ── Payment CTA ──────────────────────────────────────────────────────────
  let payButtonHtml = '';
  const btnStyle = `display:inline-block;background:${accentColor};color:#0c0d0f;text-decoration:none;
    font-family:'Courier New',Courier,monospace;font-weight:700;font-size:14px;
    padding:13px 32px;border-radius:8px;letter-spacing:.04em;`;
  const subStyle = `font-size:11px;color:#4a4c52;font-family:'Courier New',Courier,monospace;
    letter-spacing:.04em;`;

  if (payMethod === 'zelle' && (payId || customZelleUrl)) {
    if (customZelleUrl) {
      const safeZelleUrl = safeUrl(customZelleUrl);
      if (safeZelleUrl) {
        payButtonHtml = `
        <tr><td align="center" style="padding:24px 0 6px;">
          <a href="${safeZelleUrl}" style="${btnStyle}">Pay via Zelle — $${total.toFixed(2)}</a>
        </td></tr>
        <tr><td align="center" style="padding:0 0 4px;">
          <span style="${subStyle}">Zelle to ${escapeHtml(payId)}</span>
        </td></tr>`;
      }
    } else {
      payButtonHtml = `
      <tr><td align="center" style="padding:24px 0 6px;">
        <div style="display:inline-block;background:${accentBg};border:1px solid ${accentBorder};
          color:${accentColor};font-family:'Courier New',Courier,monospace;font-weight:700;
          font-size:14px;padding:13px 32px;border-radius:8px;letter-spacing:.04em;">
          $${total.toFixed(2)} due via Zelle
        </div>
      </td></tr>
      <tr><td align="center" style="padding:0 0 4px;">
        <span style="${subStyle}">Send to ${escapeHtml(payId)} on Zelle</span>
      </td></tr>`;
    }
  } else if (payMethod === 'venmo' && payId) {
    const handle  = encodeURIComponent(payId.replace('@', ''));
    const note    = encodeURIComponent(`Bills ${monthLabel}`);
    const url     = `https://venmo.com/${handle}?txn=charge&amount=${total.toFixed(2)}&note=${note}`;
    payButtonHtml = `
    <tr><td align="center" style="padding:24px 0 6px;">
      <a href="${url}" style="${btnStyle}">Pay via Venmo — $${total.toFixed(2)}</a>
    </td></tr>
    <tr><td align="center" style="padding:0 0 4px;">
      <span style="${subStyle}">Venmo @${escapeHtml(payId.replace('@', ''))}</span>
    </td></tr>`;
  } else if (payMethod === 'cashapp' && payId) {
    const tag = encodeURIComponent(payId.replace('$', ''));
    const url = `https://cash.app/$${tag}`;
    payButtonHtml = `
    <tr><td align="center" style="padding:24px 0 6px;">
      <a href="${url}" style="${btnStyle}">Pay via Cash App — $${total.toFixed(2)}</a>
    </td></tr>
    <tr><td align="center" style="padding:0 0 4px;">
      <span style="${subStyle}">Cash App $${escapeHtml(payId.replace('$', ''))}</span>
    </td></tr>`;
  } else {
    payButtonHtml = `
    <tr><td align="center" style="padding:24px 0 6px;">
      <div style="display:inline-block;background:${accentBg};border:1px solid ${accentBorder};
        color:${accentColor};font-family:'Courier New',Courier,monospace;font-weight:700;
        font-size:14px;padding:13px 32px;border-radius:8px;letter-spacing:.04em;">
        Total Due: $${total.toFixed(2)}
      </div>
    </td></tr>`;
  }

  // ── Bill rows ─────────────────────────────────────────────────────────────
  const billRowsHtml = bills.map(b => `
    <tr>
      <td style="padding:10px 16px;font-family:Arial,sans-serif;font-size:13px;
                 color:#767880;border-bottom:1px solid #2a2c31;">${escapeHtml(b.name)}</td>
      <td style="padding:10px 16px;font-family:'Courier New',Courier,monospace;font-size:13px;
                 color:${accentColor};font-weight:600;text-align:right;
                 border-bottom:1px solid #2a2c31;">$${b.amount.toFixed(2)}</td>
    </tr>`).join('');

  // ── Full HTML ─────────────────────────────────────────────────────────────
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>Bills for ${escapeHtml(monthLabel)}</title>
</head>
<body style="margin:0;padding:0;background-color:#0c0d0f;font-family:Arial,sans-serif;">

<table width="100%" cellpadding="0" cellspacing="0" style="background:#0c0d0f;padding:32px 16px;">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">

  <!-- Logo / Wordmark -->
  <tr>
    <td style="padding:0 0 24px;">
      <table cellpadding="0" cellspacing="0">
        <tr>
          <td style="vertical-align:middle;">${HEX_LOGO}</td>
          <td style="padding-left:12px;vertical-align:middle;">
            <div>
              <span style="font-family:Arial,sans-serif;font-weight:900;font-size:20px;
                           color:#e4e5e8;letter-spacing:-.01em;">Bill</span><span
                    style="font-family:Arial,sans-serif;font-weight:900;font-size:20px;
                           color:#F5A800;letter-spacing:-.01em;">Hive</span>
            </div>
            <div style="font-size:9px;color:#4a4c52;letter-spacing:.16em;
                        text-transform:uppercase;margin-top:2px;
                        font-family:'Courier New',Courier,monospace;">Household Manager</div>
          </td>
        </tr>
      </table>
    </td>
  </tr>

  <!-- Card -->
  <tr>
    <td style="background:#141518;border:1px solid #2a2c31;border-radius:12px;overflow:hidden;">
      <table width="100%" cellpadding="0" cellspacing="0">

        <!-- Person accent bar -->
        <tr>
          <td style="background:${accentColor};height:3px;font-size:0;line-height:0;">&nbsp;</td>
        </tr>

        <!-- Greeting -->
        <tr>
          <td style="padding:28px 28px 6px;">
            <div style="font-size:22px;font-weight:800;color:#e4e5e8;font-family:Arial,sans-serif;
                        letter-spacing:-.02em;">
              ${escapeHtml(greeting) || ('Hi ' + escapeHtml(personName) + ',')}
            </div>
            <div style="font-size:13px;color:#767880;margin-top:8px;font-family:Arial,sans-serif;
                        line-height:1.5;">
              Here's your share of the household bills for
              <strong style="color:#e4e5e8;">${escapeHtml(monthLabel)}</strong>.
            </div>
          </td>
        </tr>

        <!-- Month badge -->
        <tr>
          <td style="padding:12px 28px 0;">
            <span style="display:inline-block;background:${accentBg};border:1px solid ${accentBorder};
                         color:${accentColor};font-family:'Courier New',Courier,monospace;
                         font-size:10px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;
                         padding:4px 10px;border-radius:4px;">${escapeHtml(monthLabel)}</span>
          </td>
        </tr>

        <!-- Bill table -->
        <tr>
          <td style="padding:16px 28px 0;">
            <table width="100%" cellpadding="0" cellspacing="0"
                   style="border:1px solid #2a2c31;border-radius:8px;overflow:hidden;
                          border-collapse:separate;border-spacing:0;">
              <thead>
                <tr style="background:#1c1e22;">
                  <th style="padding:9px 16px;font-family:'Courier New',Courier,monospace;font-size:10px;
                             font-weight:600;color:#4a4c52;text-align:left;text-transform:uppercase;
                             letter-spacing:.1em;">Bill</th>
                  <th style="padding:9px 16px;font-family:'Courier New',Courier,monospace;font-size:10px;
                             font-weight:600;color:#4a4c52;text-align:right;text-transform:uppercase;
                             letter-spacing:.1em;">Your Share</th>
                </tr>
              </thead>
              <tbody>
                ${billRowsHtml}
              </tbody>
              <tfoot>
                <tr style="background:#1c1e22;">
                  <td style="padding:12px 16px;font-family:Arial,sans-serif;font-size:13px;
                             font-weight:700;color:#e4e5e8;">Total</td>
                  <td style="padding:12px 16px;font-family:'Courier New',Courier,monospace;
                             font-size:18px;font-weight:700;color:${accentColor};text-align:right;">
                    $${total.toFixed(2)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </td>
        </tr>

        <!-- Payment CTA -->
        <tr>
          <td>
            <table width="100%" cellpadding="0" cellspacing="0">
              ${payButtonHtml}
            </table>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="padding:20px 28px 24px;border-top:1px solid #2a2c31;">
            <div style="font-size:11px;color:#4a4c52;font-family:'Courier New',Courier,monospace;
                        letter-spacing:.02em;">
              Sent by <span style="color:#767880;">${escapeHtml(fromName)}</span>
              via <span style="color:#F5A800;">BillHive</span>
              &nbsp;·&nbsp; Reply with any questions.
            </div>
          </td>
        </tr>

      </table>
    </td>
  </tr>

  <!-- Bottom wordmark -->
  <tr>
    <td style="padding:20px 0 0;text-align:center;">
      <span style="font-size:10px;color:#2a2c31;font-family:'Courier New',Courier,monospace;
                   letter-spacing:.12em;text-transform:uppercase;">
        BillHive · Household Bill Manager
      </span>
    </td>
  </tr>

</table>
</td></tr>
</table>
</body>
</html>`;

  // ── Plain text fallback ───────────────────────────────────────────────────
  const text = [
    greeting || ('Hi ' + personName + ','),
    '',
    `Here's your share of the bills for ${monthLabel}:`,
    '',
    ...bills.map(b => `  ${b.name.padEnd(24)} $${b.amount.toFixed(2)}`),
    '',
    '  ' + '─'.repeat(30),
    `  Total you owe:         $${total.toFixed(2)}`,
    '',
    payMethod === 'zelle'   && payId ? `Please pay via Zelle to ${payId}.` :
    payMethod === 'venmo'   && payId ? `Please pay via Venmo @${payId.replace('@','')}.` :
    payMethod === 'cashapp' && payId ? `Please pay via Cash App $${payId.replace('$','')}.` :
    'Please send your share when you get a chance.',
    '',
    `Thanks, ${fromName}`,
  ].join('\n');

  return { html, text };
}

module.exports = { buildEmailHtml };
