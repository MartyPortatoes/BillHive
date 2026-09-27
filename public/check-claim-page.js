(async function () {
  'use strict';
  const root = document.getElementById('root');
  const path = location.pathname.match(/^(.*?)\/share\/([A-Za-z0-9_-]{16,128})\/?$/);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  if (!path) { root.innerHTML = '<div class="error"><h1>Invalid check link</h1><p>Open the complete link sent by the host.</p></div>'; return; }
  root.innerHTML = `<div class="brand"><div class="brand-hex" aria-hidden="true"></div><span>BillHive</span></div>
    <h1 class="check-name" id="check-title">Shared check</h1><p class="check-date" id="check-date"></p>
    <p id="message" class="notice state-message" role="status" aria-live="polite"></p>
    <p id="availability" class="notice"></p>
    <section id="comparison" class="card comparison" aria-label="Changed check comparison" hidden></section>
    <section class="card" id="selection-card" hidden><h2>Choose your items</h2>
      <p class="notice">Your selections go to the host for review. The host determines your final share, including shared items and adjustments.</p>
      <div id="items"></div><p id="selected-total" class="notice"></p><p id="adjustments" class="notice"></p>
      <label class="name-label" for="nameInput">Your name</label>
      <div class="name-row"><input type="text" id="nameInput" autocomplete="name" maxlength="80" placeholder="e.g. Alex" /></div>
      <p class="notice">This browser keeps your identity for this link. Changing your name updates your existing selection. An empty selection lets you join without items or withdraw your previous items.</p>
    </section>
    <section class="card" id="claims-card" hidden><h2>Guest selections</h2><div id="claims"></div></section>
    <div class="tools"><button type="button" id="refresh">Refresh check</button><button type="button" id="clear">Clear selected items</button>
      <button type="button" id="export">Export recovery copy</button><button type="button" id="reload">Reopen saved selection</button><button type="button" id="discard">Discard draft</button></div>`;
  const dock = document.createElement('div'); dock.className = 'action-dock';
  dock.innerHTML = '<button class="primary" id="confirmBtn" type="button" disabled>Loading…</button>'; document.body.append(dock);
  const sizeDock = () => document.documentElement.style.setProperty('--dock-height', dock.getBoundingClientRect().height + 'px');
  new ResizeObserver(sizeDock).observe(dock); sizeDock();
  const $ = id => document.getElementById(id);
  let client, working = null, busy = false, queued = 0, failedPersistence = false, issue = '', success = '';
  let writes = Promise.resolve();
  const current = () => client?.row;
  const pending = () => current()?.pending;
  const unknown = () => !!pending() && !pending().rejection;
  const canEdit = () => !!current()?.snapshot && current().access === 'active' && current().snapshot.revisionPreconditionsRequired && !current().snapshot.check.isCompleted && !unknown() && !busy;
  const money = amount => {
    try { return new Intl.NumberFormat(navigator.language, {style:'currency',currency:current()?.snapshot?.currencyCode || 'USD'}).format(amount); }
    catch (_) { return String(amount); }
  };
  function refreshControls() {
    const row = current(), snapshot = row?.snapshot;
    const review = !!client?.needsReview();
    $('message').textContent = issue || (queued ? 'Saving your selection in this browser…' : success || (row?.draft ? 'Your unfinished selection is saved in this browser.' : ''));
    $('message').classList.toggle('problem', !!issue);
    $('availability').textContent = unknown() ? 'This selection is awaiting confirmation. Retry sends the original saved request.' :
      row?.access !== 'active' && row ? 'This link is unavailable. The last available check is shown; your selection remains available for recovery.' :
      snapshot?.check.isCompleted ? 'This check is completed. You can view your saved selection and export a recovery copy.' :
      snapshot && !snapshot.revisionPreconditionsRequired ? 'The host needs to enable protected sharing before this browser can send selections.' :
      review ? 'The check or guest selections changed. Compare the previous and current values, then review your selection again.' : '';
    $('nameInput').disabled = !canEdit();
    root.querySelectorAll('input[data-item]').forEach(input => { input.disabled = !canEdit(); });
    $('refresh').disabled = busy || queued > 0 || failedPersistence;
    $('clear').disabled = !canEdit() || queued > 0;
    $('reload').disabled = busy || queued > 0;
    $('export').disabled = !working && !row;
    $('discard').disabled = busy || queued > 0 || unknown() || !row?.draft || failedPersistence;
    const button = $('confirmBtn');
    button.textContent = busy ? 'Working…' : unknown() ? 'Retry saved selection' : review ? 'Keep choices and review again' : working?.itemIds.length ? 'Send selection to host' : 'Send empty selection';
    button.disabled = busy || queued > 0 || failedPersistence || (!unknown() && (!canEdit() || !working?.name.trim() || working.name.trim().length > 80 ||
      working.itemIds.some(id => !snapshot.check.items.some(item => item.id === id))));
    const selected = new Set(working?.itemIds || []);
    const subtotal = snapshot?.check.items.filter(i => selected.has(i.id)).reduce((sum, i) => sum + i.price, 0) || 0;
    $('selected-total').textContent = 'Selected items at full prices: ' + money(subtotal) + '. This is not a final amount owed.';
  }
  function selectionText(snapshot) {
    if (!snapshot) return '';
    return `<p><strong>${escape(snapshot.check.name)}</strong> · ${escape(snapshot.currencyCode)}</p>` +
      snapshot.check.items.map(i => `<p>${escape(i.name)}: ${escape(i.price)} ${escape(snapshot.currencyCode)}</p>`).join('') +
      `<p>Tax ${escape(snapshot.check.taxAmount)} · Tip ${escape(snapshot.check.tipAmount)} · Discount ${escape(snapshot.check.discountAmount)} · Complimentary ${escape(snapshot.check.compAmount)} · Service fee ${escape(snapshot.check.serviceFeeAmount)}</p>` +
      snapshot.claims.map(c => `<p>${escape(c.claimerName)} · ${escape(c.claimantId?.slice(-8) || 'earlier selection')}: ${escape(c.itemIds.map(id => snapshot.check.items.find(i => i.id === id)?.name || id).join(', ') || 'No items')}</p>`).join('');
  }
  function render() {
    const row = current(), snapshot = row?.snapshot;
    $('selection-card').hidden = !snapshot; $('claims-card').hidden = !snapshot;
    if (!snapshot) { refreshControls(); return; }
    if (!working) working = client.form();
    $('check-title').textContent = snapshot.check.name;
    const rawDate = snapshot.check.dateISO;
    const calendarDate = typeof rawDate === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(rawDate);
    const date = calendarDate ? new Date(Number(calendarDate[1]),Number(calendarDate[2])-1,Number(calendarDate[3])) : new Date(rawDate);
    $('check-date').textContent = Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString();
    const items = snapshot.check.items.map(i => ({...i,removed:false}));
    for (const id of working.itemIds) if (!items.some(i => i.id === id)) {
      const old = working.baseline.check.items.find(i => i.id === id); items.push({id,name:old?.name || id,price:old?.price || 0,removed:true});
    }
    $('items').innerHTML = items.map((item, index) => `<label class="item" for="item-${index}">
      <input type="checkbox" id="item-${index}" data-item="${escape(item.id)}" ${working.itemIds.includes(item.id) ? 'checked' : ''}/>
      <span class="name">${escape(item.name)}${item.removed ? ' — removed; uncheck to continue' : ''}</span><span class="price">${escape(money(item.price))}</span></label>`).join('') || '<p>No items on this check yet.</p>';
    $('adjustments').textContent = 'Check adjustments: Tax ' + money(snapshot.check.taxAmount) + ' · Tip ' + money(snapshot.check.tipAmount) +
      ' · Discount ' + money(snapshot.check.discountAmount) + ' · Complimentary ' + money(snapshot.check.compAmount) + ' · Service fee ' + money(snapshot.check.serviceFeeAmount);
    $('nameInput').value = working.name;
    $('claims').innerHTML = snapshot.claims.map(c => `<div class="claim-row"><span class="who">${escape(c.claimerName)} ${c.claimantId === row.claimantId ? '(you)' : ''}
      <small>· ${escape(c.claimantId?.slice(-8) || 'earlier selection')}</small></span><span class="what">${escape(c.itemIds.map(id => snapshot.check.items.find(i => i.id === id)?.name || id).join(', ') || 'No items selected')}</span></div>`).join('') || '<p>No guest selections yet.</p>';
    $('comparison').hidden = !client.needsReview();
    if (!$('comparison').hidden) $('comparison').innerHTML = '<h2>Review changes</h2><h3>Previously reviewed</h3>' + selectionText(row.draft?.baseline) +
      '<h3>Current check and selections</h3>' + selectionText(snapshot) + '<p>Unavailable items stay in your selection until you explicitly uncheck them below.</p>';
    refreshControls();
  }
  function persistForm() {
    if (!working || !canEdit()) return;
    working = {...working,name:$('nameInput').value,itemIds:Array.from(root.querySelectorAll('input[data-item]:checked'), input => input.dataset.item)};
    const form = structuredClone(working); queued++; success = ''; refreshControls();
    writes = writes.then(async () => {
      if (failedPersistence) return;
      try { await client.edit(form); }
      catch (error) { failedPersistence = true; issue = error.message + ' Your latest choices are not saved. Export a recovery copy before reopening.'; }
    }).finally(() => { queued--; refreshControls(); });
  }
  $('nameInput').addEventListener('input', persistForm);
  $('items').addEventListener('change', persistForm);
  $('clear').addEventListener('click', () => { root.querySelectorAll('input[data-item]').forEach(input => { input.checked = false; }); persistForm(); });
  async function action(work, allowUnsaved = false) {
    if (busy) return;
    busy = true; issue = ''; success = ''; refreshControls();
    try {
      await writes;
      if (failedPersistence && !allowUnsaved) throw new Error('Your latest choices are not saved. Export them or explicitly reopen the saved selection.');
      await work();
    } catch (error) { issue = error.message || 'The selection could not be confirmed. Your saved data is kept.'; }
    finally { busy = false; render(); }
  }
  $('refresh').addEventListener('click', () => action(async () => { await client.refresh(); if (!working) working = client.form(); }));
  $('reload').addEventListener('click', () => {
    if (failedPersistence && !confirm('Replace your unsaved choices with the saved selection? Export a recovery copy first if you need them.')) return;
    action(async () => { await client.open(); failedPersistence = false; working = client.form(); if (!unknown()) await client.refresh(); working = client.form(); }, true);
  });
  $('discard').addEventListener('click', () => {
    if (!confirm('Discard this unfinished draft? Your previously submitted selection will remain.')) return;
    action(async () => { await client.discard(); working = client.form(); success = 'Unfinished draft discarded.'; });
  });
  $('export').addEventListener('click', () => {
    const copy = client?.recovery(working) || JSON.stringify({working});
    const url = URL.createObjectURL(new Blob([copy], {type:'application/json'}));
    const link = document.createElement('a'); link.href = url; link.download = 'check-selection-recovery.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  $('confirmBtn').addEventListener('click', () => action(async () => {
    if (unknown()) { await client.submit(); working = client.form(); success = 'Your saved selection is confirmed.'; return; }
    if (client.needsReview()) { await client.review(working); working = client.form(); success = 'Current values reviewed. Send your selection when ready.'; return; }
    if (!current().draft) await client.edit(working);
    await client.refresh();
    if (client.needsReview()) return;
    await client.prepare(); await client.submit(); working = client.form(); success = 'Selection recorded. The host will review the final split.';
  }));
  window.addEventListener('beforeunload', event => { if (queued || failedPersistence) { event.preventDefault(); event.returnValue = ''; } });
  try {
    client = new BillHiveCheckClaims.Client({token:path[2],prefix:path[1]});
    await action(async () => { await client.open(); working = client.form(); if (!unknown()) await client.refresh(); working = client.form(); });
  } catch (error) { issue = error.message; refreshControls(); }
})();
