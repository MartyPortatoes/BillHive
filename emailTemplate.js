/**
 * Builds the HTML and plain-text email for a bill summary.
 *
 * @param {object} opts
 * @param {string} opts.greeting      — e.g. "Hey babe," or "Hi Dad,"
 * @param {string} opts.personName    — display name
 * @param {string} opts.accentColor   — hex color for accents
 * @param {string} opts.monthLabel    — e.g. "March 2026"
 * @param {Array}  opts.bills         — [{ name, amount }]
 * @param {number} opts.total         — total owed
 * @param {string} opts.payMethod     — 'zelle' | 'venmo' | 'manual' | 'none'
 * @param {string} opts.payId         — zelle phone/email or venmo @handle
 * @param {number} opts.payAmount     — amount for deep link
 * @param {string} opts.fromName      — sender display name
 */
function buildEmailHtml(opts) {
  const {
    greeting, personName, accentColor = '#a8e063',
    monthLabel, bills, total, payMethod, payId, fromName = 'BillFlow',
  } = opts;

  // Slightly lighten accent for subtle backgrounds
  const accentBg = accentColor + '22';
  const accentBorder = accentColor + '55';

  // Payment button
  let payButtonHtml = '';
  if (payMethod === 'zelle' && payId) {
    const zelleData = encodeURIComponent(JSON.stringify({ name: personName, token: payId, amount: total.toFixed(2) }));
    const zelleUrl = `https://enroll.zellepay.com/qr-codes?data=${zelleData}`;
    payButtonHtml = `
      <tr><td align="center" style="padding:28px 0 8px;">
        <a href="${zelleUrl}"
           style="display:inline-block;background:${accentColor};color:#0c0d0f;text-decoration:none;
                  font-family:Arial,sans-serif;font-weight:700;font-size:15px;
                  padding:14px 36px;border-radius:8px;letter-spacing:.02em;">
          💰 Pay via Zelle — $${total.toFixed(2)}
        </a>
      </td></tr>
      <tr><td align="center" style="padding:0 0 8px;">
        <span style="font-size:11px;color:#6b7280;font-family:Arial,sans-serif;">
          Zelle to ${payId}
        </span>
      </td></tr>`;
  } else if (payMethod === 'venmo' && payId) {
    const handle = payId.replace('@', '');
    const note = encodeURIComponent(`Bills ${monthLabel}`);
    const venmoUrl = `https://venmo.com/${handle}?txn=charge&amount=${total.toFixed(2)}&note=${note}`;
    payButtonHtml = `
      <tr><td align="center" style="padding:28px 0 8px;">
        <a href="${venmoUrl}"
           style="display:inline-block;background:${accentColor};color:#0c0d0f;text-decoration:none;
                  font-family:Arial,sans-serif;font-weight:700;font-size:15px;
                  padding:14px 36px;border-radius:8px;letter-spacing:.02em;">
          💸 Pay via Venmo — $${total.toFixed(2)}
        </a>
      </td></tr>
      <tr><td align="center" style="padding:0 0 8px;">
        <span style="font-size:11px;color:#6b7280;font-family:Arial,sans-serif;">
          Venmo @${handle}
        </span>
      </td></tr>`;
  } else {
    payButtonHtml = `
      <tr><td align="center" style="padding:28px 0 8px;">
        <div style="display:inline-block;background:${accentBg};border:1px solid ${accentBorder};
                    color:${accentColor};font-family:Arial,sans-serif;font-weight:700;font-size:15px;
                    padding:14px 36px;border-radius:8px;letter-spacing:.02em;">
          Total Due: $${total.toFixed(2)}
        </div>
      </td></tr>`;
  }

  // Bill rows
  const billRowsHtml = bills.map(b => `
    <tr>
      <td style="padding:10px 16px;font-family:Arial,sans-serif;font-size:13px;
                 color:#d1d5db;border-bottom:1px solid #2a2d31;">${b.name}</td>
      <td style="padding:10px 16px;font-family:Arial,sans-serif;font-size:13px;
                 color:${accentColor};font-weight:600;text-align:right;
                 border-bottom:1px solid #2a2d31;">$${b.amount.toFixed(2)}</td>
    </tr>`).join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Bills for ${monthLabel}</title></head>
<body style="margin:0;padding:0;background-color:#0c0d0f;font-family:Arial,sans-serif;">

<table width="100%" cellpadding="0" cellspacing="0" style="background:#0c0d0f;padding:32px 16px;">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">

  <!-- Header / Logo -->
  <tr>
    <td style="padding:0 0 24px;">
      <table cellpadding="0" cellspacing="0">
        <tr>
          <td style="background:${accentColor};width:36px;height:36px;border-radius:8px;
                     text-align:center;vertical-align:middle;">
            <span style="font-size:16px;line-height:36px;">🏠</span>
          </td>
          <td style="padding-left:10px;">
            <span style="font-family:Arial,sans-serif;font-weight:900;font-size:20px;color:#f9fafb;">Bill</span><span style="font-family:Arial,sans-serif;font-weight:900;font-size:20px;color:${accentColor};">Flow</span>
            <div style="font-size:10px;color:#6b7280;letter-spacing:.12em;text-transform:uppercase;margin-top:1px;">household manager</div>
          </td>
        </tr>
      </table>
    </td>
  </tr>

  <!-- Card -->
  <tr>
    <td style="background:#16181c;border:1px solid #2a2d31;border-radius:12px;overflow:hidden;">
      <table width="100%" cellpadding="0" cellspacing="0">

        <!-- Card header accent bar -->
        <tr>
          <td style="background:${accentColor};height:4px;font-size:0;line-height:0;">&nbsp;</td>
        </tr>

        <!-- Greeting -->
        <tr>
          <td colspan="2" style="padding:28px 28px 8px;">
            <div style="font-size:22px;font-weight:700;color:#f9fafb;font-family:Arial,sans-serif;">
              ${greeting || ('Hi ' + personName + ',')}
            </div>
            <div style="font-size:14px;color:#9ca3af;margin-top:6px;font-family:Arial,sans-serif;">
              Here's your share of the household bills for <strong style="color:#f9fafb;">${monthLabel}</strong>.
            </div>
          </td>
        </tr>

        <!-- Bill table -->
        <tr>
          <td colspan="2" style="padding:20px 28px 0;">
            <table width="100%" cellpadding="0" cellspacing="0"
                   style="border:1px solid #2a2d31;border-radius:8px;overflow:hidden;border-collapse:separate;border-spacing:0;">
              <thead>
                <tr style="background:#1e2024;">
                  <th style="padding:10px 16px;font-family:Arial,sans-serif;font-size:11px;
                             font-weight:600;color:#6b7280;text-align:left;text-transform:uppercase;
                             letter-spacing:.08em;">Bill</th>
                  <th style="padding:10px 16px;font-family:Arial,sans-serif;font-size:11px;
                             font-weight:600;color:#6b7280;text-align:right;text-transform:uppercase;
                             letter-spacing:.08em;">Your Share</th>
                </tr>
              </thead>
              <tbody>
                ${billRowsHtml}
              </tbody>
              <tfoot>
                <tr style="background:#1e2024;">
                  <td style="padding:12px 16px;font-family:Arial,sans-serif;font-size:13px;
                             font-weight:700;color:#f9fafb;">Total</td>
                  <td style="padding:12px 16px;font-family:Arial,sans-serif;font-size:16px;
                             font-weight:900;color:${accentColor};text-align:right;">
                    $${total.toFixed(2)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </td>
        </tr>

        <!-- Payment button -->
        <table width="100%" cellpadding="0" cellspacing="0">
          ${payButtonHtml}
        </table>

        <!-- Footer -->
        <tr>
          <td colspan="2" style="padding:24px 28px;border-top:1px solid #2a2d31;">
            <div style="font-size:12px;color:#6b7280;font-family:Arial,sans-serif;">
              Sent by ${fromName} via BillFlow &nbsp;·&nbsp;
              <span style="color:#4b5563;">Reply to this email if you have any questions.</span>
            </div>
          </td>
        </tr>

      </table>
    </td>
  </tr>

  <!-- Footer -->
  <tr>
    <td style="padding:20px 0 0;text-align:center;">
      <span style="font-size:11px;color:#374151;font-family:Arial,sans-serif;">
        BillFlow · Household Bill Manager
      </span>
    </td>
  </tr>

</table>
</td></tr>
</table>
</body>
</html>`;

  // Plain text fallback
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
    payMethod === 'zelle' && payId ? `Please pay via Zelle to ${payId}.` :
    payMethod === 'venmo' && payId ? `Please pay via Venmo @${payId.replace('@','')}.` :
    'Please send your share when you get a chance.',
    '',
    `Thanks, ${fromName}`,
  ].join('\n');

  return { html, text };
}

module.exports = { buildEmailHtml };
