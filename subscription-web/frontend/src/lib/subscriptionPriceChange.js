const PRICE_TOLERANCE = 0.05;
const MIN_CONFIRMING_PAYMENTS = 2;

function isSamePrice(a, b) {
  const average = (Math.abs(a) + Math.abs(b)) / 2;
  return average > 0 && Math.abs(a - b) / average <= PRICE_TOLERANCE;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function localDateKey(date) {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
}

function toPayment(payment) {
  const sourceDate = payment?.date;
  const date = new Date(sourceDate);
  const amount = Math.abs(Number(payment?.amount));
  if (Number.isNaN(date.getTime()) || !Number.isFinite(amount) || amount === 0) return null;
  const dateKey = typeof sourceDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sourceDate)
    ? sourceDate
    : localDateKey(date);
  return { date, dateKey, amount };
}

function trailingPriceLevel(payments, endIndex) {
  const amounts = [payments[endIndex].amount];
  for (let i = endIndex - 1; i >= 0; i -= 1) {
    if (!isSamePrice(payments[i].amount, median(amounts))) break;
    amounts.push(payments[i].amount);
  }
  return { startIndex: endIndex - amounts.length + 1, price: median(amounts), count: amounts.length };
}

/**
 * Detects one confirmed latest tariff change within a single subscription's
 * payments. Two consecutive payments are required for both tariff levels so
 * an isolated unusual charge cannot be reported as a price change.
 */
export function detectSubscriptionPriceChange(payments) {
  const sorted = (Array.isArray(payments) ? payments : [])
    .map(toPayment)
    .filter(Boolean)
    .sort((a, b) => a.date - b.date);

  if (sorted.length < MIN_CONFIRMING_PAYMENTS * 2) return { hasChange: false };

  const newLevel = trailingPriceLevel(sorted, sorted.length - 1);
  if (newLevel.count < MIN_CONFIRMING_PAYMENTS || newLevel.startIndex === 0) {
    return { hasChange: false };
  }

  const oldLevel = trailingPriceLevel(sorted, newLevel.startIndex - 1);
  if (oldLevel.count < MIN_CONFIRMING_PAYMENTS || isSamePrice(oldLevel.price, newLevel.price)) {
    return { hasChange: false };
  }

  const difference = +(newLevel.price - oldLevel.price).toFixed(2);
  const percentChange = +((difference / oldLevel.price) * 100).toFixed(2);
  if (Math.abs(percentChange) < PRICE_TOLERANCE * 100) return { hasChange: false };

  return {
    hasChange: true,
    direction: difference > 0 ? "up" : "down",
    oldPrice: +oldLevel.price.toFixed(2),
    newPrice: +newLevel.price.toFixed(2),
    difference,
    percentChange,
    changedAt: sorted[newLevel.startIndex].dateKey,
  };
}


