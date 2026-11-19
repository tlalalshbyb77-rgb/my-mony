/*
 * محرك الحكم على المصروف: تحويل الأرقام، وحساب النسبة، وإصدار الحكم.
 * الملف لا يلمس الواجهة ولا التخزين، لذلك يمكن اختباره وحده.
 */
(function () {
  'use strict';

  const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
  const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
  const FULLWIDTH_DIGITS = '０１２３４５６７８９';

  /**
   * يحوّل نصًا ماليًا إلى رقم.
   * الفاصلة تُعتبر عشرية فقط إذا تبعها رقم أو رقمان في آخر النص،
   * وإلا فهي فاصل آلاف. والعكس صحيح لنقاط الآلاف المتعددة.
   */
  function normalizeNumber(value) {
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : NaN;
    }
    if (value === null || value === undefined) {
      return NaN;
    }

    let text = String(value).trim();
    if (!text) {
      return NaN;
    }

    text = text
      .replace(/[٠-٩]/g, (digit) => String(ARABIC_DIGITS.indexOf(digit)))
      .replace(/[۰-۹]/g, (digit) => String(PERSIAN_DIGITS.indexOf(digit)))
      .replace(/[０-９]/g, (digit) => String(FULLWIDTH_DIGITS.indexOf(digit)))
      .replace(/٫/g, '.')
      .replace(/٬/g, '')
      .replace(/[−–—]/g, '-')
      .replace(/[^\d.,-]/g, '');

    if (!text) {
      return NaN;
    }

    // الأرقام العشرية التي تبدأ بفاصلة مثل «٫5» أو «.5».
    text = text.replace(/^(-?)([.,])(\d)/, (match, sign, separator, digit) =>
      sign + '0' + separator + digit
    );

    // نقاط أو فواصل زائدة (مثل «د.ل» تتحول إلى نقطة في النهاية) لا تُغيّر الرقم.
    text = text.replace(/^\.+/, '').replace(/[.,]+$/, '');
    if (!text || text === '-') {
      return NaN;
    }

    // فاصلة عشرية في نهاية النص: 1,5 أو 12,50
    text = text.replace(/,(\d{1,2})$/, '.$1');
    // ما تبقى من فواصل هو فاصل آلاف
    text = text.replace(/,/g, '');

    // أكثر من نقطة واحدة: الأخيرة عشرية إن كانت خانتين أو أقل
    const parts = text.split('.');
    if (parts.length > 2) {
      const lastPart = parts.pop();
      const head = parts.join('');
      text = lastPart.length <= 2 ? head + '.' + lastPart : head + lastPart;
    }

    const result = Number(text);
    return Number.isFinite(result) ? result : NaN;
  }

  /**
   * يحكم على مصروف قبل حفظه.
   * balance: الرصيد الحالي، available: المتاح بعد الالتزامات والأهداف،
   * monthSpent: مجموع مصروفات الشهر لكل فئة، وbudgets: ميزانية كل فئة.
   */
  function judgeExpense(input) {
    const options = input || {};
    const amount = normalizeNumber(options.amount);
    const balance = Number(options.balance) || 0;
    const available = Number.isFinite(Number(options.available)) ? Number(options.available) : balance;
    const originalBalance = Number(options.originalBalance) || 0;
    const category = options.category || '';
    const history = Array.isArray(options.history) ? options.history : [];
    const budgets = options.budgets || {};
    const monthSpent = options.monthSpent || {};

    if (!Number.isFinite(amount) || amount <= 0) {
      return { ok: false, error: 'اكتب مبلغًا صحيحًا أكبر من صفر، فالدفتر لا يفهم الأرقام الغامضة.' };
    }

    const config = window.WALLET_CONFIG;
    const base = balance > 0 ? balance : originalBalance > 0 ? originalBalance : amount;
    const ratio = amount / base;
    const necessary = typeof config.isNecessary === 'function'
      ? config.isNecessary(category)
      : false;
    const thresholds = config.thresholds || [0.05, 0.15, 0.35];

    let level = ratio < thresholds[0] ? 0 : ratio < thresholds[1] ? 1 : ratio < thresholds[2] ? 2 : 3;

    const sevenDaysAgo = Date.now() - 7 * 86400000;
    const repeated = history.some((item) =>
      item.type === 'expense' && item.category === category && item.when > sevenDaysAgo
    );
    const remainingLow = originalBalance > 0 && (balance - amount) / originalBalance < 0.1;

    // الضروريات تبدأ من «يستاهل» ولا تُعاقب على التكرار أو ضعف المتبقي.
    if (necessary) {
      level = 0;
    } else {
      if (repeated) level += 1;
      if (remainingLow) level += 1;
    }

    const budget = Number(budgets[category]) || 0;
    const spentThisMonth = Number(monthSpent[category]) || 0;
    const overBudget = budget > 0 && spentThisMonth + amount > budget;
    if (overBudget) level += 1;

    level = Math.max(0, Math.min(3, level));

    const severities = ['light', 'medium', 'high', 'full'];
    const verdicts = ['يستاهل', 'فكّر ثاني', 'ما يستاهل', 'ما يستاهل'];
    const expressions = ['happy', 'worried', 'sad', 'crying'];

    let warning = null;
    if (amount > balance) {
      warning = {
        type: 'over-balance',
        text: 'هذا المبلغ أكبر من رصيدك الحالي. سجّله فقط إذا حدث الصرف فعلًا وتقبل أن يصبح الرصيد سالبًا.'
      };
    } else if (amount > available) {
      warning = {
        type: 'over-available',
        text: 'هذا يمس مبالغ محجوزة لالتزامات أو أهداف. يمكنك التسجيل رغم ذلك بعد تأكيد صريح.'
      };
    }

    let expression = expressions[level];
    if (warning && warning.type === 'over-balance') {
      expression = 'shocked';
    } else if (warning && warning.type === 'over-available' && level === 0) {
      expression = 'worried';
    }

    return {
      ok: true,
      amount,
      level,
      severity: severities[level],
      verdict: verdicts[level],
      expression,
      ratio,
      necessary,
      repeated,
      overBudget,
      remainingLow,
      warning
    };
  }

  window.WalletJudge = {
    normalizeNumber,
    judgeExpense
  };
})();
