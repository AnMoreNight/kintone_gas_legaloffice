/**
 * Kintone daily sync: records with LINEユーザーID, then rows in 入金情報 where
 * the checkbox is "check" and 入金check is non-empty → collect 入金予定日.
 *
 * Set Script properties (Project Settings → Script properties):
 *   KINTONE_API_TOKEN — API token with record read permission for the app
 *
 * Or edit CONFIG below (avoid committing tokens to source control).
 */
var CONFIG = {
  subdomain: 'se3x0ggs88tk',
  appId: '6',
  KINTONE_API_TOKEN : 'Hq6Uip99I9E9mfuw7JmUSOEozuIN4xrKzzt30DdB',
  /** Base query (same idea as records API). Adjust if needed. */
  query: '案件ステータス = "受任"',
  /** Subtable checkbox field (sample: check_0 with option "check") */
  subtableCheckboxField: 'check_0',
  /** Checkbox option label to match (sample uses lowercase "check") */
  checkboxOption: 'check',
};

var FIELD_LINE_USER_ID = 'LINEユーザーID';
var FIELD_PAYMENT_SUBTABLE = '入金情報';
var FIELD_PAYMENT_CHECK = '入金check';
var FIELD_PAYMENT_DUE_DATE = '入金予定日';

/**
 * Entry point: bind to a daily time-driven trigger.
 */
function kintoneDailySync() {
  var token = getApiToken_();
  var results = fetchAndProcessRecords_(token);
  onDailySyncComplete_(results);
  return results;
}

/**
 * For manual test in the GAS editor.
 */
function kintoneDailySync_debug() {
  var results = kintoneDailySync();
  Logger.log(JSON.stringify(results, null, 2));
}

function getApiToken_() {
  var p = PropertiesService.getScriptProperties().getProperty('KINTONE_API_TOKEN');
  if (p) return p;
  throw new Error('Set Script property KINTONE_API_TOKEN or extend getApiToken_.');
}

/**
 * @returns {Array<{recordId:string,lineUserId:string,dates:string[],rows:Object[]}>}
 */
function fetchAndProcessRecords_(token) {
  var all = getAllRecords_(token);
  var out = [];
  for (var i = 0; i < all.length; i++) {
    var rec = all[i];
    var fields = rec && rec.record;
    if (!fields) continue;

    if (!hasLineUserId_(fields)) continue;

    var extracted = extractPaymentDueDates_(fields);
    if (extracted.dates.length === 0) continue;

    out.push({
      recordId: String(fields.$id && fields.$id.value != null ? fields.$id.value : ''),
      lineUserId: String(fields[FIELD_LINE_USER_ID].value || '').trim(),
      dates: extracted.dates,
      rows: extracted.rows,
    });
  }
  return out;
}

function hasLineUserId_(fields) {
  var f = fields[FIELD_LINE_USER_ID];
  if (!f || f.value == null) return false;
  var v = String(f.value).trim();
  return v.length > 0;
}

/**
 * @returns {{dates:string[], rows:Array<{subtableRowId:string,入金予定日:string}>}}
 */
function extractPaymentDueDates_(fields) {
  var dates = [];
  var rows = [];
  var st = fields[FIELD_PAYMENT_SUBTABLE];
  if (!st || st.type !== 'SUBTABLE' || !st.value || !st.value.length) {
    return { dates: dates, rows: rows };
  }

  var opt = CONFIG.checkboxOption;
  var optLower = opt.toLowerCase();

  for (var i = 0; i < st.value.length; i++) {
    var row = st.value[i];
    var rv = row.value;
    if (!rv) continue;

    if (!checkboxHasOption_(rv, CONFIG.subtableCheckboxField, optLower)) continue;
    if (!isNonEmptyCalcOrText_(rv[FIELD_PAYMENT_CHECK])) continue;

    var due = rv[FIELD_PAYMENT_DUE_DATE];
    var dateStr = due && due.value != null ? String(due.value).trim() : '';
    if (!dateStr) continue;

    dates.push(dateStr);
    rows.push({
      subtableRowId: row.id != null ? String(row.id) : '',
      入金予定日: dateStr,
    });
  }
  return { dates: dates, rows: rows };
}

function checkboxHasOption_(rowValue, fieldCode, optionLower) {
  var box = rowValue[fieldCode];
  if (!box || box.type !== 'CHECK_BOX' || !box.value) return false;
  var arr = box.value;
  for (var i = 0; i < arr.length; i++) {
    if (String(arr[i]).toLowerCase() === optionLower) return true;
  }
  return false;
}

function isNonEmptyCalcOrText_(field) {
  if (!field || field.value == null) return false;
  var s = String(field.value).trim();
  return s.length > 0;
}

function getAllRecords_(token) {
  var base =
    'https://' +
    CONFIG.subdomain +
    '.cybozu.com/k/v1/records.json?app=' +
    encodeURIComponent(CONFIG.appId) +
    '&query=' +
    encodeURIComponent(CONFIG.query);
  var limit = 500;
  var offset = 0;
  var collected = [];

  while (true) {
    var url = base + '&totalCount=false&limit=' + limit + '&offset=' + offset;
    var res = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: { 'X-Cybozu-API-Token': token },
      muteHttpExceptions: true,
    });
    var code = res.getResponseCode();
    var body = res.getContentText();
    if (code !== 200) {
      throw new Error('Kintone API ' + code + ': ' + body);
    }
    var json = JSON.parse(body);
    var records = json.records || [];
    for (var i = 0; i < records.length; i++) collected.push(records[i]);
    if (records.length < limit) break;
    offset += limit;
  }
  return collected;
}

/**
 * Override or extend: send LINE messages, write to Sheet, etc.
 * @param {Array<{recordId:string,lineUserId:string,dates:string[],rows:Object[]}>} results
 */
function onDailySyncComplete_(results) {
  Logger.log('Kintone daily sync: ' + results.length + ' record(s) with payment dates.');
  for (var i = 0; i < results.length; i++) {
    Logger.log(results[i]);
  }
}
