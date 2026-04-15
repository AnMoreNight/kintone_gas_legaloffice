/**
 * Kintone → filter records and read 入金予定・実入金 fields from 入金情報 (see sample.json shape).
 * API: GET .../k/v1/records.json?app=6&totalCount=true&query=案件ステータス = "受任"
 *
 * LINE Messaging API credentials: set `LINE_CONFIG` in this file, or Script properties
 * (Project Settings → Script properties):
 *   LINE_CHANNEL_ACCESS_TOKEN — channel access token (required for push)
 *   LINE_CHANNEL_SECRET — channel secret (optional; webhook signature only, not used for push)
 */

var KINTONE_BASE = "https://se3x0ggs88tk.cybozu.com";
var KINTONE_APP_ID = 6;
/** Set in Project Settings → Script properties as KINTONE_API_TOKEN, or replace below. */
var KINTONE_API_TOKEN = "Hq6Uip99I9E9mfuw7JmUSOEozuIN4xrKzzt30DdB";

/** LINE Messaging API. channelSecret is for webhooks / future use; push uses channelAccessToken. */
var LINE_CONFIG = {
  channelAccessToken:
    "bYSIor5ZppVyqqqnfeCwUUOpb1MB6OLTJ4A9ASbU9Xxj7Tee9PBw++mL5efSFZKjzTIE9q7yc/JzPBF4LHlelz6l6cYbtmPZ2g7HWRO02QlMQbeQ3Tq8yyA1uqXPfPYD5/EsN+0KERvuvr/h9aj4fwdB04t89/1O/w1cDnyilFU=",
  channelSecret: "e89e8a93983e4230d19efc1b75c75858",
};

var RECORDS_PATH = "/k/v1/records.json";
var QUERY_FILTER = '案件ステータス = "受任"';
/** Smaller pages + only needed fields avoid huge bodies that truncate and break JSON.parse. */
var PAGE_SIZE = 100;

var LINE_PUSH_URL = "https://api.line.me/v2/bot/message/push";

function getLineChannelAccessToken_() {
  var c =
    LINE_CONFIG &&
    LINE_CONFIG.channelAccessToken &&
    String(LINE_CONFIG.channelAccessToken).trim();
  if (c) {
    return c;
  }
  var t = PropertiesService.getScriptProperties().getProperty(
    "LINE_CHANNEL_ACCESS_TOKEN",
  );
  return t ? String(t).trim() : "";
}

function getLineChannelSecret_() {
  var c =
    LINE_CONFIG &&
    LINE_CONFIG.channelSecret &&
    String(LINE_CONFIG.channelSecret).trim();
  if (c) {
    return c;
  }
  var s = PropertiesService.getScriptProperties().getProperty(
    "LINE_CHANNEL_SECRET",
  );
  return s ? String(s).trim() : "";
}

/**
 * Sends a text push message to one LINE user (Messaging API).
 * @param {string} lineUserId — value from kintone  LINEユーザーID
 * @param {string} text — body (LINE max 5000 chars)
 */
function sendLinePushMessage(lineUserId, text) {
  var token = getLineChannelAccessToken_();
  if (!token) {
    throw new Error(
      "Set LINE_CONFIG.channelAccessToken or script property LINE_CHANNEL_ACCESS_TOKEN (LINE channel access token).",
    );
  }
  if (!lineUserId || !String(lineUserId).trim()) {
    throw new Error("lineUserId is empty");
  }
  var payload = {
    to: String(lineUserId).trim(),
    messages: [{ type: "text", text: String(text) }],
  };
  var res = UrlFetchApp.fetch(LINE_PUSH_URL, {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + token },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  var code = res.getResponseCode();
  var bodyText = res.getContentText();
  if (code !== 200) {
    var errSnippet =
      bodyText.length > 600 ? bodyText.slice(0, 600) + "…" : bodyText;
    throw new Error("LINE push HTTP " + code + ": " + errSnippet);
  }
  return { ok: true };
}

function buildRecordsUrl(queryString) {
  var qs = [
    "app=" + KINTONE_APP_ID,
    "totalCount=true",
    "query=" + encodeURIComponent(queryString),
    "fields[0]=" + encodeURIComponent("$id"),
    "fields[1]=" + encodeURIComponent("LINEユーザーID"),
    "fields[2]=" + encodeURIComponent("入金情報"),
    "fields[3]=" + encodeURIComponent("ID"),
  ];
  return KINTONE_BASE + RECORDS_PATH + "?" + qs.join("&");
}

/**
 * Fetches all pages for the filtered query, then applies LINE / 入金情報 rules.
 * @returns {{ totalCount: (number|null), matched: Array<{recordId: string, lineUserId: string, 入金予定: Array<{入金予定日: string, 入金予定額: string, 実入金日: string, 実入金額: string}>}> }} recordId = app field ID (NUMBER), not $id
 */
function runKintoneLineDepositDates() {
  if (!KINTONE_API_TOKEN) {
    throw new Error(
      "Set script property KINTONE_API_TOKEN (kintone API token for app 6).",
    );
  }

  var all = [];
  var offset = 0;
  var more = true;
  /** Kintone total record count for the query (from totalCount=true). Same on every page. */
  var totalCount = null;

  while (more) {
    var q =
      QUERY_FILTER +
      " order by $id asc limit " +
      PAGE_SIZE +
      " offset " +
      offset;
    var url = buildRecordsUrl(q);

    var res = UrlFetchApp.fetch(url, {
      method: "get",
      headers: { "X-Cybozu-API-Token": KINTONE_API_TOKEN },
      muteHttpExceptions: true,
    });

    var text = res.getContentText();
    var status = res.getResponseCode();
    if (status !== 200) {
      var errSnippet = text.length > 800 ? text.slice(0, 800) + "…" : text;
      throw new Error("Kintone HTTP " + status + ": " + errSnippet);
    }

    var body;
    try {
      body = JSON.parse(text);
    } catch (parseErr) {
      var tail = text.length > 400 ? text.slice(-400) : text;
      throw new Error(
        "JSON.parse failed (bytes≈" +
          text.length +
          "): " +
          parseErr.message +
          " | tail: " +
          tail,
      );
    }

    if (typeof body.totalCount === "number") {
      totalCount = body.totalCount;
    }

    var batch = body.records || [];
    for (var i = 0; i < batch.length; i++) {
      var out = pickLineUserDepositDates(batch[i]);
      if (out) {
        all.push(out);
      }
    }

    if (batch.length < PAGE_SIZE) {
      more = false;
    } else {
      offset += PAGE_SIZE;
      Utilities.sleep(200);
    }
  }

  Logger.log(
    "Kintone totalCount (records matching query): " +
      (totalCount !== null ? totalCount : "n/a"),
  );
  Logger.log("matched after filters (LINE + 入金情報 rules): " + all.length);
  Logger.log(
    "matched summary (recordId + 入金予定 row count): " +
      JSON.stringify(
        all.map(function (m) {
          return {
            recordId: m.recordId,
            入金予定Rows: (m.入金予定 || []).length,
          };
        }),
      ),
  );

  return {
    totalCount: totalCount,
    matched: all,
  };
}

/**
 * check_0 に "check" かつ 入金check あり（3日前・前日の対象条件）
 */
function rowHasCheckFlagsFromApi_(apiRow) {
  var check0 = apiRow["check_0"];
  var check0Vals =
    check0 && check0.type === "CHECK_BOX" && Array.isArray(check0.value)
      ? check0.value
      : [];
  if (check0Vals.indexOf("check") === -1) {
    return false;
  }
  var nyukinCheck = apiRow["入金check"];
  var nyukinCheckStr =
    nyukinCheck && nyukinCheck.value != null && nyukinCheck.value !== ""
      ? String(nyukinCheck.value).trim()
      : "";
  return nyukinCheckStr !== "";
}

/**
 * 1) LINEユーザーID not empty
 * 2) 入金情報行を2系統で取り込む:
 *    A) check_0+入金check かつ 予定/実データのいずれかあり → 3日前・前日・翌日・差異のすべての判定に利用（_allowAdvanceNotice: true）
 *    B) check が外れていても 入金予定日 がある行 → 翌日未払い/不足・金額差異のみ（3日前・前日は送らない）（_allowAdvanceNotice: false）
 */
function pickLineUserDepositDates(record) {
  var lineField = record["LINEユーザーID"];
  var lineRaw =
    lineField && lineField.value != null ? String(lineField.value).trim() : "";
  if (!lineRaw) {
    return null;
  }

  var sub = record["入金情報"];
  if (!sub || sub.type !== "SUBTABLE" || !Array.isArray(sub.value)) {
    return null;
  }

  var rows = [];
  for (var r = 0; r < sub.value.length; r++) {
    var apiRow = sub.value[r].value;
    if (!apiRow) {
      continue;
    }

    var dateCell = apiRow["入金予定日"];
    var dateVal =
      dateCell && dateCell.value != null ? String(dateCell.value).trim() : "";

    var amountCell = apiRow["入金予定額"];
    var amountVal =
      amountCell && amountCell.value != null && amountCell.value !== ""
        ? String(amountCell.value).trim()
        : "";

    var actualDateCell = apiRow["実入金日"];
    var actualDateVal =
      actualDateCell && actualDateCell.value != null
        ? String(actualDateCell.value).trim()
        : "";

    var actualAmountCell = apiRow["実入金額"];
    var actualAmountVal =
      actualAmountCell &&
      actualAmountCell.value != null &&
      actualAmountCell.value !== ""
        ? String(actualAmountCell.value).trim()
        : "";

    var hasStrict = rowHasCheckFlagsFromApi_(apiRow);
    var hasData = !!(
      dateVal ||
      amountVal ||
      actualDateVal ||
      actualAmountVal
    );

    var flat = {
      入金予定日: dateVal,
      入金予定額: amountVal,
      実入金日: actualDateVal,
      実入金額: actualAmountVal,
      _allowAdvanceNotice: false,
    };

    if (hasStrict && hasData) {
      flat._allowAdvanceNotice = true;
      rows.push(flat);
    } else if (dateVal) {
      rows.push(flat);
    }
  }

  if (rows.length === 0) {
    return null;
  }

  var businessIdCell = record["ID"];
  var rid =
    businessIdCell &&
    businessIdCell.value != null &&
    String(businessIdCell.value).trim() !== ""
      ? String(businessIdCell.value).trim()
      : "";
  if (!rid) {
    var idCell = record["$id"];
    rid = idCell && idCell.value != null ? String(idCell.value).trim() : "";
  }

  return {
    recordId: rid,
    lineUserId: lineRaw,
    入金予定: rows,
  };
}

// --- Reminder timing (JST) -------------------------------------------------

var TZ_JST = "Asia/Tokyo";

/**
 * Today's calendar date in JST as yyyy-MM-dd.
 */
function getTodayYmdJst() {
  return Utilities.formatDate(new Date(), TZ_JST, "yyyy-MM-dd");
}

function ymdToUtcMs(ymd) {
  var p = String(ymd).split("-");
  if (p.length !== 3) {
    return NaN;
  }
  var y = parseInt(p[0], 10);
  var m = parseInt(p[1], 10);
  var d = parseInt(p[2], 10);
  if (!y || !m || !d) {
    return NaN;
  }
  return Date.UTC(y, m - 1, d);
}

/**
 * Calendar days from today to due (due minus today). +3 = due is in 3 days; -1 = today is one day after due.
 */
function calendarDaysFromTodayToDue(todayYmd, dueYmd) {
  var a = ymdToUtcMs(todayYmd);
  var b = ymdToUtcMs(dueYmd);
  if (isNaN(a) || isNaN(b)) {
    return NaN;
  }
  return Math.round((b - a) / 86400000);
}

function isUnpaidForOverdue(actualDateStr, actualAmountStr) {
  var d = actualDateStr && String(actualDateStr).trim() !== "";
  var amtRaw = actualAmountStr != null ? String(actualAmountStr).trim() : "";
  if (!d) {
    return true;
  }
  if (!amtRaw) {
    return true;
  }
  var n = parseFloat(amtRaw.replace(/,/g, ""));
  if (isNaN(n)) {
    return true;
  }
  if (n === 0) {
    return true;
  }
  return false;
}

/** 3日前・前日リマインド共通（【〇】→ timingLabel） */
function buildMessageAdvanceNotice_(timingLabel) {
  return (
    "お世話になっております。\n" +
    "\n" +
    "ご入金期限【" +
    timingLabel +
    "】のご連絡です。\n" +
    "期限直前は金融機関の混雑等も予想されますので、お早めのお手続きをお勧めしております。\n" +
    "\n" +
    "■ お振込先口座\n" +
    "ＧＭＯあおぞらネット銀行（0310）\n" +
    "法人営業部（101） 普通2383574\n" +
    "シホウ）チュウオウソウゴウジムショ\n" +
    "\n" +
    "既にお振込み手続きを完了されている場合は、本通知は破棄いただけますようお願い申し上げます。\n" +
    "今後とも、よろしくお願いいたします。"
  );
}

var LINE_MSG_BANK_BLOCK_DETAILED =
  "金融機関：ＧＭＯあおぞらネット銀行（0310）\n" +
  "支 店 名：法人営業部（101）\n" +
  "種  別：普通\n" +
  "口座番号：2383574\n" +
  "口座名義：シホウ）チュウオウソウゴウジムショ";

var LINE_MSG_OVERDUE_FOOTER =
  "\n\nなお、当連絡と行き違いでお振込みをいただいている場合は何卒ご容赦ください。\n" +
  "\n" +
  "また、お約束の期日にご入金が間に合わない場合は、必ず事前にご連絡をお願いいたします。\n" +
  "今後のお手続きを継続するためにも重要になりますので、至急ご返信をお待ちしております。";

/** 入金予定日翌日・未入金 */
function buildMessageOverdueUnpaid_() {
  return (
    "※重要事項の連絡※\n" +
    "期日でのご入金確認が取れなかったためご連絡いたします。\n" +
    "お振込み状況をご確認いただき、改めてご入金いただくか、遅延している旨のご連絡をいただけないでしょうか。\n" +
    "\n" +
    LINE_MSG_BANK_BLOCK_DETAILED +
    LINE_MSG_OVERDUE_FOOTER
  );
}

function formatYenAmountDisplay_(n) {
  var v = Math.round(Number(n));
  if (isNaN(v)) {
    return String(n);
  }
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** 入金予定日翌日・入金額不足（shortageYen = 不足分） */
function buildMessageOverdueShortage_(shortageYen) {
  var disp = formatYenAmountDisplay_(shortageYen);
  return (
    "※重要事項の連絡※\n" +
    "期日でのご入金について金額が " +
    disp +
    "円不足しておりましたのでご連絡いたします。\n" +
    "お振込み状況をご確認いただき、改めてご入金いただくか、遅延している旨のご連絡をいただけないでしょうか。\n" +
    "\n" +
    LINE_MSG_BANK_BLOCK_DETAILED +
    LINE_MSG_OVERDUE_FOOTER
  );
}

function parseAmountYen_(raw) {
  if (raw == null) {
    return null;
  }
  var s = String(raw)
    .trim()
    .replace(/,/g, "");
  if (s === "") {
    return null;
  }
  var n = parseFloat(s);
  if (isNaN(n)) {
    return null;
  }
  return n;
}

/**
 * 入金予定額を満たす入金が記録済みなら、支払催促系（3日前・前日・翌日未入金/不足）を送らない。
 * 実入金日・実入金額があり、かつ実入金額 ≥ 入金予定額（両方数値化できる場合）で満たしたとみなす。
 */
function isFullyPaidForRow_(row) {
  var d = row["実入金日"] != null ? String(row["実入金日"]).trim() : "";
  var aRaw = row["実入金額"] != null ? String(row["実入金額"]).trim() : "";
  if (!d || !aRaw) {
    return false;
  }
  var actual = parseAmountYen_(row["実入金額"]);
  if (actual === null || actual <= 0) {
    return false;
  }
  var exp = parseAmountYen_(row["入金予定額"]);
  if (exp === null) {
    return false;
  }
  return actual >= exp;
}

function buildMessageAmountMismatch(予定額Display, 実額Display) {
  return (
    "お世話になっております。\n" +
    "ご入金の確認のところ、お支払い予定額は " +
    予定額Display +
    "円、実際のご入金額は " +
    実額Display +
    "円 と差異がございます。\n" +
    "内容をご確認のうえ、必要に応じてご連絡ください。\n" +
    "\n" +
    LINE_MSG_BANK_BLOCK_DETAILED
  );
}

/**
 * 入金確認後（実入金額が入力済み）で予定額と実額が一致しない場合に通知。
 * 入金予定日の翌日（未入金・不足）は classifyReminderForRowJst 側で送るため、ここでは重複しない。
 * @returns {{ kind: string, message: string } | null}
 */
function classifyAmountMismatchForRow(row, todayYmd) {
  var expected = parseAmountYen_(row["入金予定額"]);
  var actual = parseAmountYen_(row["実入金額"]);
  if (expected === null || actual === null) {
    return null;
  }
  if (expected === actual) {
    return null;
  }
  /** 上振れ入金（実額 > 予定額）は通知しない */
  if (actual > expected) {
    return null;
  }

  var due = row["入金予定日"] && String(row["入金予定日"]).trim();
  if (due && todayYmd) {
    var deltaMm = calendarDaysFromTodayToDue(todayYmd, due);
    /** 入金予定日の2日後以降はリマインドしない（翌日1回のみ） */
    if (deltaMm <= -2) {
      return null;
    }
    if (deltaMm === -1) {
      var 実日 = row["実入金日"] != null ? String(row["実入金日"]).trim() : "";
      var 実額 = row["実入金額"] != null ? String(row["実入金額"]).trim() : "";
      if (isUnpaidForOverdue(実日, 実額)) {
        return null;
      }
      if (
        expected !== null &&
        actual !== null &&
        actual < expected
      ) {
        return null;
      }
    }
  }

  var 予定額Display =
    row["入金予定額"] != null ? String(row["入金予定額"]).trim() : "";
  var 実額Display =
    row["実入金額"] != null ? String(row["実入金額"]).trim() : "";

  return {
    kind: "amount_mismatch",
    message: buildMessageAmountMismatch(予定額Display, 実額Display),
  };
}

/**
 * For one 入金予定 row, returns which reminder applies today (JST), or null.
 * Due = 入金予定日, expected = 入金予定額, actual date = 実入金日, actual amount = 実入金額.
 */
function classifyReminderForRowJst(todayYmd, row) {
  var due = row["入金予定日"] && String(row["入金予定日"]).trim();
  if (!due) {
    return null;
  }

  var delta = calendarDaysFromTodayToDue(todayYmd, due);
  if (isNaN(delta)) {
    return null;
  }

  var 実日 = row["実入金日"] != null ? String(row["実入金日"]).trim() : "";
  var 実額 = row["実入金額"] != null ? String(row["実入金額"]).trim() : "";
  var expNum = parseAmountYen_(row["入金予定額"]);
  var actNum = parseAmountYen_(row["実入金額"]);

  if (delta === 3 || delta === 1) {
    /** 3日前・前日は check_0+入金check がある行のみ（pick で _allowAdvanceNotice） */
    if (row._allowAdvanceNotice === false) {
      return null;
    }
    if (isFullyPaidForRow_(row)) {
      return null;
    }
    return {
      kind: delta === 3 ? "three_days_before" : "one_day_before",
      message: buildMessageAdvanceNotice_(delta === 3 ? "3日前" : "前日"),
    };
  }

  /** 期限翌日のみ（delta === -1）。2日目以降は未払い・不足リマインドは送らない */
  if (delta === -1) {
    if (isFullyPaidForRow_(row)) {
      return null;
    }
    if (
      !isUnpaidForOverdue(実日, 実額) &&
      expNum !== null &&
      actNum !== null &&
      actNum < expNum
    ) {
      return {
        kind: "one_day_after_shortage",
        message: buildMessageOverdueShortage_(expNum - actNum),
      };
    }
    if (isUnpaidForOverdue(実日, 実額)) {
      return {
        kind: "one_day_after_overdue",
        message: buildMessageOverdueUnpaid_(),
      };
    }
    return null;
  }

  return null;
}

/**
 * Fetches Kintone data, builds reminders for today (JST), optionally sends LINE push.
 * @param {{ sendPush?: boolean }} opt — default sendPush true (requires LINE_CONFIG or LINE_CHANNEL_ACCESS_TOKEN)
 * @returns {{ totalCount: (number|null), todayYmdJst: string, reminders: Array, pushResults: Array }}
 */
function runKintoneDepositRemindersForToday(opt) {
  opt = opt || {};
  var doSend = opt.sendPush !== false;

  var data = runKintoneLineDepositDates();
  var todayYmd = getTodayYmdJst();
  var reminders = [];

  var matched = data.matched || [];
  for (var i = 0; i < matched.length; i++) {
    var rec = matched[i];
    var rows = rec["入金予定"] || [];
    for (var j = 0; j < rows.length; j++) {
      var row = rows[j];
      var hit = classifyReminderForRowJst(todayYmd, row);
      if (hit) {
        reminders.push({
          recordId: rec.recordId,
          lineUserId: rec.lineUserId,
          kind: hit.kind,
          message: hit.message,
          dueDate: row["入金予定日"] && String(row["入金予定日"]).trim(),
        });
      }
      var mismatch = classifyAmountMismatchForRow(row, todayYmd);
      if (mismatch) {
        reminders.push({
          recordId: rec.recordId,
          lineUserId: rec.lineUserId,
          kind: mismatch.kind,
          message: mismatch.message,
          dueDate: row["入金予定日"] && String(row["入金予定日"]).trim(),
        });
      }
    }
  }

  Logger.log("JST today: " + todayYmd + ", reminders: " + reminders.length);
  Logger.log(
    "reminders (recordId + kind only): " +
      JSON.stringify(
        reminders.map(function (x) {
          return { recordId: x.recordId, kind: x.kind };
        }),
      ),
  );

  var pushResults = [];
  if (doSend && reminders.length > 0) {
    if (!getLineChannelAccessToken_()) {
      throw new Error(
        "LINE channel access token is not set. Set LINE_CONFIG.channelAccessToken or LINE_CHANNEL_ACCESS_TOKEN in Script properties, or call with { sendPush: false }.",
      );
    }
    for (var k = 0; k < reminders.length; k++) {
      var item = reminders[k];
      try {
        sendLinePushMessage(item.lineUserId, item.message);
        pushResults.push({
          ok: true,
          recordId: item.recordId,
          lineUserId: item.lineUserId,
          kind: item.kind,
        });
      } catch (sendErr) {
        Logger.log(
          "LINE push failed: recordId=" +
            item.recordId +
            " kind=" +
            item.kind +
            " " +
            sendErr.message,
        );
        pushResults.push({
          ok: false,
          recordId: item.recordId,
          lineUserId: item.lineUserId,
          kind: item.kind,
          error: sendErr.message,
        });
      }
      Utilities.sleep(150);
    }
  }

  return {
    totalCount: data.totalCount,
    todayYmdJst: todayYmd,
    reminders: reminders,
    pushResults: pushResults,
  };
}
