'use strict';
const Decimal = require('./decimal-json');
const {SyncError} = require('./sync-store');
const max = value => value > 0n ? value : 0n;
function digits(currency) {
  try { return new Intl.NumberFormat('en',{style:'currency',currency}).resolvedOptions().maximumFractionDigits; }
  catch { return 2; }
}
function financial(value) {
  if (typeof value === 'string') {
    try { value = Decimal.parse(value); } catch { /* Legacy known-number text must still validate. */ }
  }
  if (!Decimal.amount(value)) throw new SyncError(409,'INVALID_BILL_AMOUNT','Review the saved bill amounts before sharing this bill.');
  return value;
}
function aligned(values) {
  const parts = values.map(value => Decimal.parts(String(financial(value))));
  const exponent = parts.reduce((minimum,p) => p.digits !== '0' && p.exponent < minimum ? p.exponent : minimum,0n);
  // Preserve any imported token in storage. Bound only this read-only calculation
  // so a hostile exponent cannot request billions of BigInt digits.
  if (exponent < -4096n) throw new SyncError(409,'BILL_PRECISION_UNSUPPORTED','This bill needs a compatible calculation client before it can be shared.');
  return {exponent, values:parts.map(p => BigInt(p.digits) * 10n ** (p.exponent - exponent))};
}
function autoEven(weights) {
  const {exponent,values} = aligned(weights);
  const scale = 10n ** -exponent, count = BigInt(values.length);
  // Compare to 100/count without ever approximating the saved weight.
  if (values.every(value => {
    const delta = value * count - 100n * scale;
    return (delta < 0n ? -delta : delta) * 1000000n < count * scale;
  })) return true;
  const roundedHundredths = (10000n * 2n + count) / (2n * count);
  return values.every((value,index) => {
    const expected = index === values.length - 1 ? 10000n - roundedHundredths * (count - 1n) : roundedHundredths;
    const delta = value * 100n - expected * scale;
    return (delta < 0n ? -delta : delta) * 1000000n < 5001n * 100n * scale;
  });
}
function shares(bill, month, fractionDigits) {
  const lines = Array.isArray(bill.lines) ? bill.lines : [];
  if (!lines.length) return [];
  const amounts = month.amounts?.[bill.id] || {};
  const remainder = lines.some(line => line.id === bill.remainderLineId) ? bill.remainderLineId : lines[0].id;
  let allocated;
  if (bill.splitType !== 'pct') {
    allocated = lines.map(line => line.id === remainder ? 0n : Decimal.units(financial(amounts[line.id] ?? 0),fractionDigits));
    const sum = allocated.reduce((a,b) => a + b,0n);
    const total = Object.hasOwn(month.totals || {},bill.id) ? Decimal.units(financial(month.totals[bill.id]),fractionDigits) : sum;
    allocated[lines.findIndex(line => line.id === remainder)] = max(total - sum);
  } else {
    const total = Decimal.units(financial(month.totals?.[bill.id] ?? 0),fractionDigits);
    const weights = lines.map(line => line.value ?? 0);
    const count = BigInt(lines.length);
    if (weights.every(value => Decimal.compare(financial(value),0) === 0) || autoEven(weights)) {
      const extraStart = count - total % count;
      allocated = lines.map((_line,index) => total / count + (BigInt(index) >= extraStart ? 1n : 0n));
    } else {
      const exactWeights = aligned(weights).values, sum = exactWeights.reduce((a,b) => a + b,0n);
      const numerators = exactWeights.map(weight => total * weight);
      allocated = numerators.map(numerator => numerator / sum);
      const remaining = total - allocated.reduce((a,b) => a + b,0n);
      const order = numerators.map((numerator,index) => ({index,remainder:numerator % sum})).sort((a,b) => a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1);
      for (let index = 0; index < Number(remaining); index++) allocated[order[index].index]++;
    }
  }
  return lines.map((line,index) => ({line,payerId:line.coveredById || line.personId,units:allocated[index]}));
}
function owes(people,bills,month,currency) {
  const fractionDigits = digits(currency), byPerson = {};
  for (const bill of Array.isArray(bills) ? bills : []) {
    const billPayer = bill.paidById || 'me';
    for (const {line,payerId,units} of shares(bill,month,fractionDigits)) {
      if (units <= 0n) continue;
      const personId = billPayer === 'me' ? payerId : billPayer;
      if (billPayer === 'me' && payerId === 'me' || billPayer !== 'me' && payerId !== 'me') continue;
      const amount = billPayer === 'me' ? units : -units;
      const entry = byPerson[personId] ||= {total:0n,bills:[]};
      let name = bill.name || '';
      if (line.coveredById && line.coveredById !== line.personId) {
        const covered = people.find(person => person.id === line.personId);
        if (covered) name += ` (covers ${covered.name})`;
      }
      entry.total += amount;
      const existing = entry.bills.find(item => item.billId === bill.id);
      if (existing) existing.units += amount;
      else entry.bills.push({billId:bill.id,billName:name,units:amount});
    }
  }
  return Object.fromEntries(Object.entries(byPerson).map(([id,entry]) => [id,{total:Decimal.fromUnits(entry.total,fractionDigits),
    bills:entry.bills.sort((a,b) => a.billName.localeCompare(b.billName)).map(item => ({billId:item.billId,billName:item.billName,amount:Decimal.fromUnits(item.units,fractionDigits)}))}]));
}
module.exports = {owes};
