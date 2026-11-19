/*
 * محفظة الندم — منطق التطبيق.
 * الحالة المركزية الوحيدة هي `state`، وكل تغيير يمر عبر `persist()`
 * ثم يعيد تصيير الأقسام المتأثرة فقط.
 */
(function () {
  'use strict';

  const CONFIG = window.WALLET_CONFIG;
  const Judge = window.WalletJudge;
  const Messages = window.WalletMessages;
  const catSVG = window.catSVG;

  const PAGE_SIZE = 30;
  const MS_DAY = 86400000;
  const MAX_BACKUP_SIZE = 2 * 1024 * 1024;
  const MAX_AMOUNT = Number(CONFIG.maxAmount) || 1e12;
  const PIN_ITERATIONS = Number(CONFIG.pinIterations) || 210000;
  const THEME_KEY = CONFIG.themeKey || 'nadam-wallet-theme';

  // ============ أدوات عامة ============

  function el(id) {
    return document.getElementById(id);
  }

  function setText(id, value) {
    const node = el(id);
    if (node) node.textContent = value;
  }

  function setHtml(id, value) {
    const node = el(id);
    if (node) node.innerHTML = value;
  }

  function show(id, visible) {
    const node = el(id);
    if (node) node.hidden = !visible;
  }

  function text(value) {
    return String(value === null || value === undefined ? '' : value).trim();
  }

  function escapeHtml(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function uid(prefix) {
    return (prefix || 'id') + '-' + Date.now().toString(36) + '-' +
      Math.random().toString(36).slice(2, 7);
  }

  function roundMoney(value, data) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    const decimals = CONFIG.decimalsFor(currencyOf(data || state));
    const factor = 10 ** decimals;
    return Math.round((number + Number.EPSILON) * factor) / factor;
  }

  function sum(list) {
    return (list || []).reduce((total, item) => total + (Number(item) || 0), 0);
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function startOfDay(value) {
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  }

  function dayKey(value) {
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return value;
    }
    const date = value instanceof Date ? value : new Date(value === undefined ? Date.now() : value);
    if (Number.isNaN(date.getTime())) {
      return dayKey(Date.now());
    }
    return date.getFullYear() + '-' +
      String(date.getMonth() + 1).padStart(2, '0') + '-' +
      String(date.getDate()).padStart(2, '0');
  }

  function monthKey(value) {
    return dayKey(value).slice(0, 7);
  }

  function parseDay(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text(value));
    if (!match) return Date.now();
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12, 0, 0, 0);
    return Number.isNaN(date.getTime()) ? Date.now() : date.getTime();
  }

  function normalizeWhen(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      if (/^\d{4}-\d{2}-\d{2}/.test(value)) return parseDay(value.slice(0, 10));
      const numeric = Number(value);
      if (Number.isFinite(numeric)) return numeric;
    }
    return Date.now();
  }

  const dateFormatter = new Intl.DateTimeFormat('ar-LY', {
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  });
  const moneyFormatters = new Map();
  let percentFormatter = null;

  function formatDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return dateFormatter.format(date);
  }

  function currencyOf(data) {
    const source = data || state;
    return source && source.currency ? source.currency : CONFIG.currencies[0];
  }

  function money(value, data) {
    const currency = currencyOf(data);
    const decimals = CONFIG.decimalsFor(currency);
    let formatter = moneyFormatters.get(decimals);
    if (!formatter) {
      formatter = new Intl.NumberFormat('ar-LY', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals
      });
      moneyFormatters.set(decimals, formatter);
    }
    return formatter.format(roundMoney(value, data));
  }

  function moneyWithCurrency(value, data) {
    return money(value, data) + ' ' + currencyOf(data);
  }

  function percent(ratio) {
    if (!percentFormatter) {
      percentFormatter = new Intl.NumberFormat('ar-LY', { maximumFractionDigits: 1 });
    }
    const value = Number.isFinite(ratio) ? ratio * 100 : 0;
    return percentFormatter.format(value) + '%';
  }

  function validAmount(value) {
    return Number.isFinite(value) && value > 0 && value <= MAX_AMOUNT;
  }

  // ============ حساب خالص (قابل للاختبار) ============

  function createEmptyState() {
    return {
      version: CONFIG.version,
      name: '',
      currency: CONFIG.currencies[0],
      openingBalance: 0,
      history: [],
      budgets: {},
      goals: [],
      commitments: [],
      customCategories: [],
      archives: [],
      pinHash: null,
      pinSalt: null,
      pinIterations: 0
    };
  }

  function allCategories(data) {
    const source = data || state || createEmptyState();
    const custom = Array.isArray(source.customCategories) ? source.customCategories : [];
    return CONFIG.categories.concat(custom.filter((item) => !CONFIG.categories.includes(item)));
  }

  function normalizeTransaction(raw, data) {
    if (!raw || typeof raw !== 'object') return null;
    const amount = roundMoney(Number(raw.amount), data);
    if (!Number.isFinite(amount) || amount <= 0) return null;

    const type = raw.type === 'income' || raw.income === true ? 'income' : 'expense';
    const when = normalizeWhen(raw.when);
    const createdAt = Number.isFinite(Number(raw.createdAt)) ? Number(raw.createdAt) : when;
    const base = {
      id: text(raw.id) || uid('tx'),
      type,
      amount,
      when,
      createdAt,
      reason: text(raw.reason).slice(0, 120)
    };

    if (type === 'income') {
      base.source = text(raw.source).slice(0, 80);
      return base;
    }

    const category = text(raw.category);
    base.category = category || CONFIG.categories[CONFIG.categories.length - 1];
    base.decision = ['pending', 'regret', 'good'].includes(raw.decision) ? raw.decision : 'pending';
    base.commitmentId = text(raw.commitmentId) || null;
    return base;
  }

  function sanitizeBudgets(raw, data) {
    const budgets = {};
    if (!raw || typeof raw !== 'object') return budgets;
    Object.keys(raw).forEach((category) => {
      const amount = roundMoney(Number(raw[category]), data);
      if (Number.isFinite(amount) && amount > 0) {
        budgets[text(category)] = amount;
      }
    });
    return budgets;
  }

  function sanitizeGoals(raw, data) {
    if (!Array.isArray(raw)) return [];
    return raw
      .map((goal) => {
        if (!goal || typeof goal !== 'object') return null;
        const target = roundMoney(Number(goal.target), data);
        const name = text(goal.name).slice(0, 60);
        if (!name || !Number.isFinite(target) || target <= 0) return null;
        const saved = clamp(roundMoney(Number(goal.saved) || 0, data), 0, target);
        const date = /^\d{4}-\d{2}-\d{2}$/.test(text(goal.date)) ? text(goal.date) : '';
        return {
          id: text(goal.id) || uid('goal'),
          name,
          target,
          saved,
          date
        };
      })
      .filter(Boolean);
  }

  function sanitizeCommitments(raw, data) {
    if (!Array.isArray(raw)) return [];
    return raw
      .map((commitment) => {
        if (!commitment || typeof commitment !== 'object') return null;
        const amount = roundMoney(Number(commitment.amount), data);
        const name = text(commitment.name).slice(0, 60);
        const day = clamp(Math.round(Number(commitment.day)) || 1, 1, 31);
        if (!name || !Number.isFinite(amount) || amount <= 0) return null;
        const paidMonths = Array.isArray(commitment.paidMonths)
          ? commitment.paidMonths.filter((month) => /^\d{4}-\d{2}$/.test(text(month)))
          : [];
        return {
          id: text(commitment.id) || uid('commitment'),
          name,
          amount,
          day,
          category: text(commitment.category) || 'ضروريات أخرى',
          paidMonths: Array.from(new Set(paidMonths))
        };
      })
      .filter(Boolean);
  }

  function sanitizeArchives(raw, data) {
    if (!Array.isArray(raw)) return [];
    return raw
      .map((archive) => {
        if (!archive || typeof archive !== 'object') return null;
        const history = (Array.isArray(archive.history) ? archive.history : [])
          .map((item) => normalizeTransaction(item, data))
          .filter(Boolean);
        const closedAt = Number(archive.closedAt);
        return {
          id: text(archive.id) || uid('archive'),
          closedAt: Number.isFinite(closedAt) ? closedAt : Date.now(),
          openingBalance: roundMoney(Number(archive.openingBalance) || 0, data),
          closingBalance: roundMoney(Number(archive.closingBalance) || 0, data),
          history
        };
      })
      .filter(Boolean);
  }

  function deriveOpeningBalance(raw, history, data) {
    if (Number.isFinite(Number(raw.openingBalance))) {
      return roundMoney(Number(raw.openingBalance), data);
    }
    // النسخ القديمة كانت تحفظ الرصيد الحالي فقط؛ نستخرج منه رصيد البداية.
    if (Number.isFinite(Number(raw.balance))) {
      const income = sum(history.filter((item) => item.type === 'income').map((item) => item.amount));
      const expense = sum(history.filter((item) => item.type === 'expense').map((item) => item.amount));
      return roundMoney(Number(raw.balance) - income + expense, data);
    }
    return 0;
  }

  function migrateState(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const data = createEmptyState();
    data.name = text(raw.name);
    data.currency = text(raw.currency) || CONFIG.currencies[0];
    const history = (Array.isArray(raw.history) ? raw.history : [])
      .map((item) => normalizeTransaction(item, data))
      .filter(Boolean);
    data.openingBalance = Math.max(0, deriveOpeningBalance(raw, history, data));
    data.history = history;
    data.budgets = sanitizeBudgets(raw.budgets, data);
    data.goals = sanitizeGoals(raw.goals, data);
    data.commitments = sanitizeCommitments(raw.commitments, data);
    data.archives = sanitizeArchives(raw.archives, data);
    data.customCategories = Array.isArray(raw.customCategories)
      ? Array.from(new Set(raw.customCategories.map((item) => text(item).slice(0, 40)).filter(Boolean)))
      : [];
    data.pinHash = /^[a-f0-9]{64}$/.test(text(raw.pinHash)) ? text(raw.pinHash) : null;
    data.pinSalt = /^[a-f0-9]{32}$/.test(text(raw.pinSalt)) ? text(raw.pinSalt) : null;
    const iterations = Number(raw.pinIterations);
    data.pinIterations = Number.isInteger(iterations) && iterations >= 10000 && iterations <= 1000000
      ? iterations
      : 0;

    // إن كان القفل قديمًا أو ناقصًا، نتركه يعمل بالبصمة القديمة ثم يُرقّى عند أول فتح ناجح.
    if (!data.pinHash) {
      data.pinSalt = null;
      data.pinIterations = 0;
    }

    return data;
  }

  function computeBalance(data) {
    if (!data) return 0;
    const income = sum(data.history.filter((item) => item.type === 'income').map((item) => item.amount));
    const expense = sum(data.history.filter((item) => item.type === 'expense').map((item) => item.amount));
    return roundMoney((Number(data.openingBalance) || 0) + income - expense, data);
  }

  function computeCommitmentReserved(data, month) {
    if (!data) return 0;
    const currentMonth = month || monthKey(Date.now());
    return roundMoney(sum(
      data.commitments
        .filter((commitment) => !(Array.isArray(commitment.paidMonths) && commitment.paidMonths.includes(currentMonth)))
        .map((commitment) => commitment.amount)
    ), data);
  }

  function computeReserved(data, month) {
    if (!data) return 0;
    const goalsSaved = sum(data.goals.map((goal) => goal.saved));
    return roundMoney(computeCommitmentReserved(data, month) + goalsSaved, data);
  }

  function computeFree(data, month) {
    return roundMoney(computeBalance(data) - computeReserved(data, month), data);
  }

  function monthSpentByCategory(data, month) {
    const target = month || monthKey(Date.now());
    const map = {};
    (data ? data.history : [])
      .filter((item) => item.type === 'expense' && monthKey(item.when) === target)
      .forEach((item) => {
        map[item.category] = roundMoney((map[item.category] || 0) + item.amount, data);
      });
    return map;
  }

  function totalIncomeInMonth(data, month) {
    const target = month || monthKey(Date.now());
    return roundMoney(sum(
      (data ? data.history : [])
        .filter((item) => item.type === 'income' && monthKey(item.when) === target)
        .map((item) => item.amount)
    ), data);
  }

  function archiveCurrentPeriod(data, closedAt) {
    if (!data) return null;
    const closingBalance = computeBalance(data);
    const archive = {
      id: uid('archive'),
      closedAt: Number.isFinite(Number(closedAt)) ? Number(closedAt) : Date.now(),
      openingBalance: roundMoney(data.openingBalance, data),
      closingBalance,
      history: data.history.map((item) => Object.assign({}, item))
    };
    return Object.assign({}, data, {
      openingBalance: closingBalance,
      history: [],
      budgets: {},
      archives: [archive].concat(Array.isArray(data.archives) ? data.archives : [])
    });
  }

  function periodRange(period, now) {
    const today = startOfDay(now || Date.now());
    if (period === 'day') {
      return { start: today, end: today + MS_DAY };
    }
    if (period === 'week') {
      const date = new Date(now || Date.now());
      const daysSinceSaturday = (date.getDay() + 1) % 7;
      const start = today - daysSinceSaturday * MS_DAY;
      return { start, end: start + 7 * MS_DAY };
    }
    if (period === 'month') {
      const date = new Date(now || Date.now());
      return {
        start: new Date(date.getFullYear(), date.getMonth(), 1).getTime(),
        end: new Date(date.getFullYear(), date.getMonth() + 1, 1).getTime()
      };
    }
    return { start: -Infinity, end: Infinity };
  }

  function inRange(value, range) {
    return value >= range.start && value < range.end;
  }

  function homeMood(data) {
    const available = computeFree(data);
    const income = totalIncomeInMonth(data);
    let ratio;
    if (income > 0) {
      ratio = available / income;
    } else if (data.openingBalance > 0) {
      ratio = available / data.openingBalance;
    } else {
      ratio = available > 0 ? 1 : available < 0 ? -1 : 0;
    }

    let expression = 'happy';
    if (ratio < 0) expression = 'crying';
    else if (ratio < 0.2) expression = 'worried';
    else if (ratio < 0.5) expression = 'happy';
    else expression = 'celebrate';

    return { expression, ratio };
  }

  function daysInMonth(date) {
    return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  }

  function dueInfo(commitment, now) {
    const today = now || new Date();
    const paidMonths = Array.isArray(commitment.paidMonths) ? commitment.paidMonths : [];
    if (paidMonths.includes(monthKey(today))) {
      return { label: 'مدفوع هذا الشهر', tone: 'paid' };
    }

    const dueDay = Math.min(commitment.day, daysInMonth(today));
    const due = new Date(today.getFullYear(), today.getMonth(), dueDay);
    const days = Math.round((startOfDay(due) - startOfDay(today)) / MS_DAY);

    if (days < 0) return { label: 'متأخر ' + Math.abs(days) + ' يوم', tone: 'late' };
    if (days === 0) return { label: 'يستحق اليوم', tone: 'soon' };
    if (days <= 3) return { label: 'يستحق خلال ' + days + ' يوم', tone: 'soon' };
    return { label: 'يستحق خلال ' + days + ' يوم', tone: 'upcoming' };
  }

  function daysUntil(dateString) {
    if (!dateString) return null;
    return Math.ceil((startOfDay(parseDay(dateString)) - startOfDay(Date.now())) / MS_DAY);
  }

  // ============ الحالة المركزية والتخزين ============

  let state = null;

  const pinGuard = {
    failures: 0,
    lockedUntil: 0
  };

  const view = {
    period: 'month',
    ledgerPage: 1,
    modalStack: [],
    modalOpeners: new Map(),
    pendingReview: null,
    editingId: null,
    fundsGoalId: null,
    fundsMode: 'deposit',
    editingCommitmentId: null,
    confirmAction: null,
    toastTimer: null
  };

  function persist() {
    if (!state) return true;
    try {
      state.version = CONFIG.version;
      localStorage.setItem(CONFIG.storageKey, JSON.stringify(state));
      return true;
    } catch (error) {
      showToast('تعذّر حفظ البيانات. قد تكون مساحة التخزين ممتلئة.');
      return false;
    }
  }

  function saveCorruptCopy(rawText) {
    try {
      localStorage.setItem(CONFIG.storageKey + '-corrupt', rawText);
    } catch (error) {
      // لا شيء إضافي ممكن هنا.
    }
  }

  function loadState() {
    let rawText;
    try {
      rawText = localStorage.getItem(CONFIG.storageKey);
    } catch (error) {
      return null;
    }
    if (!rawText) return null;

    try {
      const raw = JSON.parse(rawText);
      const migrated = migrateState(raw);
      if (!migrated) {
        saveCorruptCopy(rawText);
        return null;
      }
      if (Number(raw.version) !== CONFIG.version) {
        try {
          localStorage.setItem(CONFIG.storageKey, JSON.stringify(migrated));
        } catch (error) {
          // فشل حفظ الترقية لا يمنع فتح البيانات في هذه الجلسة.
        }
      }
      return migrated;
    } catch (error) {
      // نحتفظ بنسخة من البيانات التالفة بدل محوها بصمت.
      saveCorruptCopy(rawText);
      return null;
    }
  }

  function readRecentMessages() {
    try {
      const raw = JSON.parse(localStorage.getItem(CONFIG.recentMessagesKey));
      return Array.isArray(raw) ? raw : [];
    } catch (error) {
      return [];
    }
  }

  function writeRecentMessages(message) {
    const recent = readRecentMessages().concat(message).slice(-6);
    try {
      localStorage.setItem(CONFIG.recentMessagesKey, JSON.stringify(recent));
    } catch (error) {
      // تجاهل الفشل: الرسائل تجميلية وليست بيانات مالية.
    }
  }

  function pickMessageText(key, values) {
    const poolKey = Messages.banks[key] ? key : 'light';
    const message = Messages.pick(Messages.banks[poolKey], readRecentMessages());
    writeRecentMessages(message);
    return Messages.fill(message, values || {});
  }

  function reviewValues(review) {
    const balance = computeBalance(state);
    const remaining = review.stage === 'saved' ? balance : balance - review.amount;
    return {
      'المبلغ': money(review.amount),
      'العملة': currencyOf(),
      'النسبة': percent(review.judgment.ratio),
      'اسم_المستخدم': state.name || CONFIG.defaultUserName,
      'الرصيد_المتبقي': money(remaining)
    };
  }

  // ============ الواجهة المشتركة ============

  function showToast(message) {
    const node = el('toast');
    if (!node) return;
    node.textContent = message;
    node.hidden = false;
    window.clearTimeout(view.toastTimer);
    view.toastTimer = window.setTimeout(() => {
      node.hidden = true;
    }, 5200);
  }

  function setError(id, message) {
    const node = el(id);
    if (node) node.textContent = message || '';
  }

  function focusFirst(modal) {
    const target = modal.querySelector('input, select, textarea, button');
    if (target) {
      target.focus();
    }
  }

  function openModal(id, trigger) {
    const modal = el(id);
    if (!modal) return;
    if (view.modalStack.length === 0) {
      view.modalOpeners.set(id, trigger || document.activeElement);
    } else {
      view.modalOpeners.set(id, document.activeElement);
    }
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
    view.modalStack.push(id);
    document.body.classList.add('modal-open');
    focusFirst(modal);
  }

  function closeModal(id, options) {
    const modal = el(id);
    if (!modal) return;
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
    view.modalStack = view.modalStack.filter((item) => item !== id);

    if (id === 'confirmModal') view.confirmAction = null;
    if (id === 'reviewModal') view.pendingReview = null;

    if (view.modalStack.length === 0) {
      document.body.classList.remove('modal-open');
      const opener = view.modalOpeners.get(id);
      if (!options || options.restoreFocus !== false) {
        if (opener && typeof opener.focus === 'function') {
          opener.focus();
        }
      }
    }
    view.modalOpeners.delete(id);
  }

  function focusableIn(container) {
    return Array.from(container.querySelectorAll(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
    )).filter((node) => node.getClientRects().length > 0 && !node.closest('[hidden]'));
  }

  function keepFocusInside(container, event) {
    const focusable = focusableIn(container);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function trapFocus(event) {
    const currentId = view.modalStack[view.modalStack.length - 1];
    if (!currentId) return;
    const modal = el(currentId);
    if (modal) keepFocusInside(modal, event);
  }

  function askConfirm(message, action, options) {
    view.confirmAction = typeof action === 'function' ? action : null;
    setText('confirmMessage', message);
    setText('confirmOk', (options && options.label) || 'تأكيد');
    setText('confirmTitle', (options && options.title) || 'تأكيد الإجراء');
    openModal('confirmModal');
  }

  // ============ التصيير ============

  const renderers = {
    home: renderHome,
    pending: renderPending,
    weekly: renderWeekly,
    analytics: renderAnalytics,
    decisions: renderDecisions,
    goals: renderGoals,
    commitments: renderCommitments,
    ledger: renderLedger
  };

  function render(sections) {
    if (!state) return;
    const list = sections === 'all' ? Object.keys(renderers) : sections || [];
    list.forEach((name) => {
      if (typeof renderers[name] === 'function') renderers[name]();
    });
  }

  function renderHome() {
    const balance = computeBalance(state);
    const available = computeFree(state);
    const mood = homeMood(state);

    setText('userNameLabel', state.name || CONFIG.defaultUserName);
    setText('balanceAmount', money(balance));
    setText('balanceCurrency', currencyOf());

    const availableNode = el('availableBalance');
    if (availableNode) {
      availableNode.textContent = available < 0
        ? 'المتاح سالب: ' + moneyWithCurrency(available) + ' — راجع التزاماتك وأهدافك.'
        : 'المتاح للصرف: ' + moneyWithCurrency(available);
      availableNode.classList.toggle('negative', available < 0);
    }

    setHtml('homeCat', catSVG(mood.expression));

    const coinCount = balance <= 0 ? 0 : clamp(Math.ceil(11 * clamp(mood.ratio, 0, 1)), 1, 11);
    setHtml('coins', Array.from({ length: coinCount }, () => '<i class="coin"></i>').join(''));

    let quote = 'سجّل قرارك بعد كل مصروف لتتعلّم من اختياراتك.';
    if (available < 0) {
      quote = 'لديك التزامات أو أهداف تحتاج تمويلًا قبل أي صرف جديد.';
    } else if (available === 0) {
      quote = 'كل مبلغ محجوز لخطة. أي صرف جديد سيخرج عن الخطة.';
    }
    setText('homeQuote', quote);
  }

  function pendingReviews() {
    const todayStart = startOfDay(Date.now());
    return state.history
      .filter((item) => item.type === 'expense' && item.decision === 'pending' && item.when < todayStart)
      .sort((a, b) => b.when - a.when || b.createdAt - a.createdAt);
  }

  function renderPending() {
    const list = pendingReviews();
    show('pendingCard', list.length > 0);
    if (list.length === 0) return;

    setText('pendingCount', String(list.length));
    const visible = list.slice(0, 3);
    const rows = visible.map((item) => {
      return '<article class="pending-item">' +
        '<div class="pending-info">' +
        '<strong>' + escapeHtml(item.category) + '</strong>' +
        '<small>' + formatDate(item.when) + ' · ' + moneyWithCurrency(item.amount) + '</small>' +
        '</div>' +
        '<div class="decision-actions">' +
        '<button type="button" class="chip" data-action="decision" data-decision="regret" data-id="' +
        escapeHtml(item.id) + '">ندمت</button>' +
        '<button type="button" class="chip" data-action="decision" data-decision="good" data-id="' +
        escapeHtml(item.id) + '">مناسب</button>' +
        '</div></article>';
    }).join('');

    const more = list.length > visible.length
      ? '<p class="muted small">و' + (list.length - visible.length) + ' مصروفات أخرى تنتظر المراجعة في السجل.</p>'
      : '';
    setHtml('pendingList', rows + more);
  }

  function renderWeekly() {
    const range = periodRange('week');
    const regrets = state.history.filter((item) =>
      item.type === 'expense' && item.decision === 'regret' && inRange(item.when, range)
    );

    if (regrets.length === 0) {
      setText('weeklySummary', 'لم تسجّل ندمًا هذا الأسبوع. استمر في المراجعة الصادقة.');
      return;
    }

    const byCategory = {};
    regrets.forEach((item) => {
      byCategory[item.category] = roundMoney((byCategory[item.category] || 0) + item.amount);
    });
    const top = Object.entries(byCategory).sort((a, b) => b[1] - a[1])[0];

    setText('weeklySummary',
      'هذا الأسبوع ندمت على ' + regrets.length + ' مصروفات بقيمة ' +
      moneyWithCurrency(sum(regrets.map((item) => item.amount))) +
      '، أكثر فئة: ' + top[0] + '.'
    );
  }

  function periodTransactions() {
    const range = periodRange(view.period);
    return state.history.filter((item) => inRange(item.when, range));
  }

  function renderAnalytics() {
    const transactions = periodTransactions();
    const expenses = transactions.filter((item) => item.type === 'expense');
    const incomes = transactions.filter((item) => item.type === 'income');
    const expenseTotal = sum(expenses.map((item) => item.amount));
    const incomeTotal = sum(incomes.map((item) => item.amount));

    setHtml('analysisSummary',
      '<div class="summary-item income"><span>الدخل</span><b>+' + money(incomeTotal) + '</b></div>' +
      '<div class="summary-item expense"><span>المصروف</span><b>−' + money(expenseTotal) + '</b></div>' +
      '<div class="summary-item"><span>الصافي</span><b>' + money(incomeTotal - expenseTotal) + '</b></div>'
    );

    const byCategory = {};
    expenses.forEach((item) => {
      byCategory[item.category] = roundMoney((byCategory[item.category] || 0) + item.amount);
    });
    const ranked = Object.entries(byCategory).sort((a, b) => b[1] - a[1]);

    setText('analysisInsight', ranked.length > 0
      ? 'أكبر بند: ' + ranked[0][0] + ' بقيمة ' + moneyWithCurrency(ranked[0][1]) + '.'
      : 'لا توجد مصروفات في هذه الفترة.'
    );

    setHtml('categoryBreakdown', ranked.map((entry) => {
      const share = expenseTotal > 0 ? Math.round((entry[1] / expenseTotal) * 100) : 0;
      return '<div class="category-row">' +
        '<div><span>' + escapeHtml(entry[0]) + '</span><b>' + moneyWithCurrency(entry[1]) + '</b></div>' +
        '<div class="progress" role="progressbar" aria-label="' + escapeHtml(entry[0]) +
        '" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + share + '"><em style="width:' + share + '%"></em></div>' +
        '</div>';
    }).join(''));

    renderBudgets();
  }

  function renderBudgets() {
    const spent = monthSpentByCategory(state);
    const entries = Object.entries(state.budgets).sort((a, b) => b[1] - a[1]);

    if (entries.length === 0) {
      setHtml('budgetList', '<p class="budget-empty">لا توجد ميزانية لهذا الشهر بعد.</p>' +
        '<button type="button" class="text-button" data-action="budget">+ ضع ميزانية للفئات</button>');
      return;
    }

    const rows = entries.map((entry) => {
      const category = entry[0];
      const limit = entry[1];
      const used = spent[category] || 0;
      const share = clamp(Math.round((used / limit) * 100), 0, 100);
      const over = used > limit;
      return '<div class="budget-row' + (over ? ' over' : '') + '">' +
        '<div><span>' + escapeHtml(category) + '</span><b>' + money(used) + ' / ' + money(limit) + '</b></div>' +
        '<div class="progress" role="progressbar" aria-label="' + escapeHtml(category) +
        '" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + share + '"><em style="width:' + share + '%"></em></div>' +
        (over ? '<small class="over-note">تجاوزت الميزانية بمقدار ' + moneyWithCurrency(used - limit) + '</small>' : '') +
        '</div>';
    }).join('');

    setHtml('budgetList', '<h3>ميزانية الشهر</h3>' + rows);
  }

  function renderDecisions() {
    const expenses = state.history.filter((item) => item.type === 'expense');
    const regrets = expenses.filter((item) => item.decision === 'regret');
    const goods = expenses.filter((item) => item.decision === 'good');
    const pending = expenses.filter((item) => item.decision === 'pending');

    const byCategory = {};
    regrets.forEach((item) => {
      byCategory[item.category] = roundMoney((byCategory[item.category] || 0) + item.amount);
    });
    const top = Object.entries(byCategory).sort((a, b) => b[1] - a[1])[0];

    setHtml('decisionSummary',
      '<div class="decision bad"><span>قرارات ندمت عليها</span><b>' + regrets.length + ' · ' +
      money(sum(regrets.map((item) => item.amount))) + '</b>' +
      (top ? '<small>الأكثر: ' + escapeHtml(top[0]) + '</small>' : '<small>لا ندم مسجّل</small>') + '</div>' +
      '<div class="decision good"><span>قرارات مناسبة</span><b>' + goods.length + ' · ' +
      money(sum(goods.map((item) => item.amount))) + '</b>' +
      '<small>بانتظار المراجعة: ' + pending.length + ' من ' + expenses.length + '</small></div>'
    );
  }

  function renderGoals() {
    if (state.goals.length === 0) {
      setHtml('goalList', '<p class="goal-empty">ضع هدفًا لتعرف أين تريد أن يصل توفيرك.</p>');
      return;
    }

    const rows = state.goals.map((goal) => {
      const progress = clamp(Math.round((goal.saved / goal.target) * 100), 0, 100);
      const complete = goal.saved >= goal.target;
      const remaining = roundMoney(goal.target - goal.saved);
      const left = daysUntil(goal.date);
      const monthsLeft = left === null ? null : Math.max(1, Math.ceil(left / 30));
      const monthly = !complete && monthsLeft ? Math.ceil(remaining / monthsLeft) : 0;

      const timeline = [];
      if (goal.date) timeline.push('الموعد: ' + formatDate(parseDay(goal.date)));
      if (left !== null) timeline.push(left >= 0 ? 'متبقي ' + left + ' يوم' : 'الموعد مضى');
      if (monthly > 0) timeline.push('المقترح الشهري: ' + money(monthly));

      return '<article class="goal-row">' +
        '<div class="goal-head"><strong>' + escapeHtml(goal.name) + '</strong>' +
        (complete ? '<span class="goal-badge">تحقق الهدف 🎉</span>' : '') + '</div>' +
        '<small>' + (timeline.join(' · ') || 'بدون موعد') + '</small>' +
        '<b>' + money(goal.saved) + ' / ' + money(goal.target) + ' ' + escapeHtml(currencyOf()) + '</b>' +
        '<div class="progress" role="progressbar" aria-label="' + escapeHtml(goal.name) +
        '" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + progress + '"><em style="width:' + progress + '%"></em></div>' +
        (complete ? '<div class="goal-cat">' + catSVG('celebrate') + '</div>' : '') +
        '<div class="goal-actions">' +
        '<button type="button" class="text-button" data-action="deposit" data-id="' + escapeHtml(goal.id) + '">أضف مبلغًا</button>' +
        '<button type="button" class="text-button" data-action="withdraw" data-id="' + escapeHtml(goal.id) + '"' +
        (goal.saved <= 0 ? ' disabled' : '') + '>سحب مبلغ</button>' +
        '<button type="button" class="tiny-delete" data-action="deleteGoal" data-id="' + escapeHtml(goal.id) +
        '" aria-label="حذف الهدف ' + escapeHtml(goal.name) + '">حذف</button>' +
        '</div></article>';
    }).join('');

    setHtml('goalList', rows);
  }

  function renderCommitments() {
    const reserved = computeCommitmentReserved(state);
    setText('commitmentReserved', 'المحجوز هذا الشهر: ' + moneyWithCurrency(reserved));

    if (state.commitments.length === 0) {
      setHtml('commitmentList', '<p class="commitment-empty">لا توجد التزامات مسجلة.</p>');
      return;
    }

    const rows = state.commitments.map((commitment) => {
      const due = dueInfo(commitment);
      const paid = due.tone === 'paid';
      return '<article class="commitment-row ' + due.tone + '">' +
        '<div class="commitment-info">' +
        '<strong>' + escapeHtml(commitment.name) + '</strong>' +
        '<small>' + escapeHtml(commitment.category) + ' · يوم ' + commitment.day + '</small>' +
        '<span class="badge ' + due.tone + '">' + due.label + '</span>' +
        '</div>' +
        '<b>' + moneyWithCurrency(commitment.amount) + '</b>' +
        '<div class="commitment-actions">' +
        '<button type="button" class="chip pay" data-action="payCommitment" data-id="' + escapeHtml(commitment.id) + '"' +
        (paid ? ' disabled' : '') + '>' + (paid ? 'مدفوع' : 'تم الدفع هذا الشهر') + '</button>' +
        '<button type="button" class="chip" data-action="editCommitment" data-id="' + escapeHtml(commitment.id) + '">تعديل</button>' +
        '<button type="button" class="tiny-delete" data-action="deleteCommitment" data-id="' + escapeHtml(commitment.id) +
        '" aria-label="حذف الالتزام ' + escapeHtml(commitment.name) + '">حذف</button>' +
        '</div></article>';
    }).join('');

    setHtml('commitmentList', rows);
  }

  function decisionLabel(decision) {
    if (decision === 'regret') return 'ندمت عليها';
    if (decision === 'good') return 'قرار مناسب';
    return 'لم تُراجع بعد';
  }

  function renderLedger() {
    const filter = el('typeFilter') ? el('typeFilter').value : 'all';
    const search = text(el('searchFilter') ? el('searchFilter').value : '').toLowerCase();

    const filtered = state.history
      .slice()
      .sort((a, b) => b.when - a.when || b.createdAt - a.createdAt)
      .filter((item) => {
        const haystack = [item.category, item.source, item.reason].join(' ').toLowerCase();
        const matchesSearch = !search || haystack.includes(search);
        if (!matchesSearch) return false;
        if (filter === 'all') return true;
        if (filter === 'income') return item.type === 'income';
        if (filter === 'expense') return item.type === 'expense';
        if (filter === 'pending') return item.type === 'expense' && item.decision === 'pending';
        return item.type === 'expense' && item.decision === filter;
      });

    const visible = filtered.slice(0, view.ledgerPage * PAGE_SIZE);

    if (visible.length === 0) {
      setHtml('activityList', '<p class="activity-empty">لا توجد نتائج مطابقة. جرّب تغيير الفلتر أو أضف حركة جديدة.</p>');
    } else {
      setHtml('activityList', visible.map(renderLedgerRow).join(''));
    }

    const remaining = filtered.length - visible.length;
    const moreButton = el('loadMore');
    if (moreButton) {
      moreButton.hidden = remaining <= 0;
      moreButton.textContent = 'عرض المزيد (' + remaining + ')';
    }
  }

  function renderLedgerRow(item) {
    const isIncome = item.type === 'income';
    const title = isIncome ? (item.source || 'دخل') : item.category;
    const note = isIncome ? 'دخل' : (item.reason || 'دون ملاحظة');
    const sign = isIncome ? '+' : '−';

    let decisions = '';
    if (!isIncome) {
      decisions = '<div class="activity-decisions">' +
        buildDecisionButton(item, 'regret', 'ندمت') +
        buildDecisionButton(item, 'good', 'مناسب') +
        buildDecisionButton(item, 'pending', 'لم أحدد بعد') +
        '</div>';
    }

    return '<article class="activity-item ' + (isIncome ? 'income' : 'expense') + '">' +
      '<span class="activity-icon" aria-hidden="true">' + (isIncome ? '＋' : '−') + '</span>' +
      '<div class="activity-info">' +
      '<strong>' + escapeHtml(title) + '</strong>' +
      '<small>' + escapeHtml(note) + ' · ' + formatDate(item.when) + '</small>' +
      '<small class="decision-status ' + (isIncome ? 'none' : item.decision) + '">' +
      (isIncome ? 'دخل' : decisionLabel(item.decision)) + '</small>' +
      '</div>' +
      '<b class="activity-amount">' + sign + money(item.amount) + '</b>' +
      '<button type="button" class="row-action" data-action="edit" data-id="' + escapeHtml(item.id) + '">تعديل</button>' +
      decisions +
      '</article>';
  }

  function buildDecisionButton(item, decision, label) {
    const active = item.decision === decision;
    return '<button type="button" class="chip' + (active ? ' active' : '') + '" ' +
      'data-action="decision" data-decision="' + decision + '" data-id="' + escapeHtml(item.id) + '" ' +
      'aria-pressed="' + String(active) + '">' + label + '</button>';
  }

  // ============ مراجعة المصروف ============

  function openSpendModal() {
    const form = el('spendForm');
    if (form) form.reset();
    setError('formError', '');
    fillCategorySelect('category', '');
    const dateField = el('expenseDate');
    if (dateField) dateField.value = dayKey(Date.now());
    openModal('spendModal');
  }

  function submitSpend(event) {
    event.preventDefault();
    const amount = Judge.normalizeNumber(el('amount').value);
    if (!validAmount(amount)) {
      setError('formError', 'اكتب مبلغًا صحيحًا أكبر من صفر.');
      return;
    }

    const category = el('category').value;
    if (!allCategories().includes(category)) {
      setError('formError', 'اختر فئة من القائمة.');
      return;
    }

    const balance = computeBalance(state);
    const available = computeFree(state);
    const judgment = Judge.judgeExpense({
      amount,
      balance,
      available,
      originalBalance: state.openingBalance,
      category,
      history: state.history,
      budgets: state.budgets,
      monthSpent: monthSpentByCategory(state)
    });

    if (!judgment.ok) {
      setError('formError', judgment.error);
      return;
    }

    const review = {
      amount: roundMoney(amount),
      category,
      when: parseDay(el('expenseDate').value),
      reason: text(el('reason').value).slice(0, 100),
      judgment,
      stage: 'judge',
      confirmed: false,
      message: '',
      savedMessage: '',
      spentMessage: ''
    };
    review.message = pickMessageText(judgment.necessary ? 'necessary' : judgment.severity, reviewValues(review));

    view.pendingReview = review;
    closeModal('spendModal', { restoreFocus: false });
    openModal('reviewModal');
    renderReview();
  }

  function renderReview() {
    const review = view.pendingReview;
    if (!review) return;
    const judgment = review.judgment;

    setHtml('reviewCat', catSVG(judgment.expression));
    setText('reviewCatName', CONFIG.catName + ' يقول:');
    setText('reviewVerdict', judgment.verdict);

    const balance = computeBalance(state);
    setText('reviewMeta',
      moneyWithCurrency(review.amount) + ' · ' + percent(judgment.ratio) +
      ' من الرصيد · المتبقي بعد الصرف: ' + moneyWithCurrency(balance - review.amount)
    );

    const alerts = [];
    if (judgment.overBudget) {
      alerts.push('<p class="alert warn">تجاوزت ميزانية هذه الفئة.</p>');
    }
    if (judgment.warning) {
      alerts.push('<p class="alert ' + (judgment.warning.type === 'over-balance' ? 'danger' : 'warn') + '">' +
        escapeHtml(judgment.warning.text) + '</p>');
    }
    if (judgment.warning && review.confirmed) {
      alerts.push('<p class="alert danger">تم التأكيد المبدئي. اضغط زر التأكيد مرة أخرى لتسجيل المصروف فعلًا.</p>');
    }
    setHtml('reviewAlerts', alerts.join(''));

    const isJudgeStage = review.stage === 'judge';
    show('reviewChoices', isJudgeStage);
    show('reviewDoneWrap', !isJudgeStage);

    const verdictNode = el('reviewVerdict');
    if (verdictNode) {
      verdictNode.className = review.stage === 'saved'
        ? 'verdict verdict-light'
        : 'verdict verdict-' + judgment.severity;
    }

    if (isJudgeStage) {
      setText('reviewMessage', review.message);
      setText('reviewConfirm',
        judgment.warning && review.confirmed ? 'تأكيد المصروف رغم التحذير' : 'سأصرف'
      );
      return;
    }

    if (review.stage === 'saved') {
      if (!review.savedMessage) {
        review.savedMessage = pickMessageText('saved', reviewValues(review));
      }
      setHtml('reviewCat', catSVG('celebrate'));
      setText('reviewVerdict', 'تراجعت بنجاح');
      setText('reviewMessage', review.savedMessage);
      setText('reviewMeta', 'لم يُسجَّل أي مصروف، و' + moneyWithCurrency(review.amount) + ' بقيت في محفظتك.');
    } else {
      if (!review.spentMessage) {
        review.spentMessage = pickMessageText('spent', reviewValues(review));
      }
      setText('reviewMessage', review.spentMessage);
      setText('reviewMeta', 'سُجّل المصروف: ' + moneyWithCurrency(review.amount) + ' في ' + review.category + '.');
    }
  }

  function cancelReviewedSpend() {
    if (!view.pendingReview || view.pendingReview.stage !== 'judge') return;
    view.pendingReview.stage = 'saved';
    renderReview();
  }

  function confirmReviewedSpend() {
    const review = view.pendingReview;
    if (!review || review.stage !== 'judge') return;

    if (review.judgment.warning && !review.confirmed) {
      review.confirmed = true;
      renderReview();
      return;
    }

    state.history.push({
      id: uid('tx'),
      type: 'expense',
      amount: review.amount,
      category: review.category,
      reason: review.reason,
      when: review.when,
      createdAt: Date.now(),
      decision: 'pending',
      commitmentId: null
    });
    persist();
    review.stage = 'spent';
    render(['home', 'analytics', 'decisions', 'ledger', 'pending']);
    renderReview();
  }

  function closeReview() {
    closeModal('reviewModal');
    view.pendingReview = null;
  }

  // ============ الدخل والتعديل ============

  function openIncomeModal() {
    const form = el('incomeForm');
    if (form) form.reset();
    setError('incomeError', '');
    const dateField = el('incomeDate');
    if (dateField) dateField.value = dayKey(Date.now());
    openModal('incomeModal');
  }

  function submitIncome(event) {
    event.preventDefault();
    const amount = Judge.normalizeNumber(el('incomeAmount').value);
    if (!validAmount(amount)) {
      setError('incomeError', 'أدخل مبلغًا صحيحًا أكبر من صفر.');
      return;
    }

    state.history.push({
      id: uid('tx'),
      type: 'income',
      amount: roundMoney(amount),
      source: text(el('incomeSource').value).slice(0, 80),
      reason: '',
      when: parseDay(el('incomeDate').value),
      createdAt: Date.now()
    });
    persist();
    closeModal('incomeModal');
    render(['home', 'analytics', 'ledger']);
    showToast('تم تسجيل الدخل. الرصيد يتنفس بشكل أفضل.');
  }

  function findTransaction(id) {
    return state.history.find((item) => item.id === id) || null;
  }

  // إعادة شهر الالتزام إلى «غير مدفوع» فقط إذا لم تبقَ حركة أخرى مرتبطة به في الشهر نفسه.
  function releaseCommitmentMonth(commitmentId, month) {
    if (!commitmentId || !month) return;
    const commitment = state.commitments.find((item) => item.id === commitmentId);
    if (!commitment) return;
    const stillPaid = state.history.some((entry) =>
      entry.commitmentId === commitmentId && monthKey(entry.when) === month
    );
    if (!stillPaid) {
      commitment.paidMonths = (Array.isArray(commitment.paidMonths) ? commitment.paidMonths : [])
        .filter((item) => item !== month);
    }
  }

  function markCommitmentMonth(commitmentId, month) {
    if (!commitmentId || !month) return;
    const commitment = state.commitments.find((item) => item.id === commitmentId);
    if (!commitment) return;
    if (!Array.isArray(commitment.paidMonths)) commitment.paidMonths = [];
    if (!commitment.paidMonths.includes(month)) {
      commitment.paidMonths.push(month);
    }
  }

  function openEdit(id) {
    const item = findTransaction(id);
    if (!item) return;
    view.editingId = id;

    el('editAmount').value = String(item.amount);
    el('editDate').value = dayKey(item.when);
    el('editNote').value = item.reason || '';
    setError('editError', '');

    const isIncome = item.type === 'income';
    show('editCategoryField', !isIncome);
    show('editSourceField', isIncome);
    show('decisionField', !isIncome);

    if (isIncome) {
      el('editSource').value = item.source || '';
    } else {
      fillCategorySelect('editCategory', item.category);
      el('editDecision').value = item.decision || 'pending';
    }

    openModal('editModal');
  }

  function applyEdit(values) {
    const item = findTransaction(view.editingId);
    if (!item) return;
    const oldMonth = item.commitmentId ? monthKey(item.when) : null;

    item.amount = values.amount;
    item.when = values.when;
    item.reason = values.reason;

    if (item.type === 'income') {
      item.source = values.source;
    } else {
      item.category = values.category;
      item.decision = values.decision;
    }

    if (item.commitmentId) {
      const newMonth = monthKey(item.when);
      releaseCommitmentMonth(item.commitmentId, oldMonth);
      markCommitmentMonth(item.commitmentId, newMonth);
    }

    persist();
    closeModal('editModal');
    render(['home', 'analytics', 'decisions', 'ledger', 'pending', 'weekly']);
    showToast('تم تحديث الحركة.');
  }

  function submitEdit(event) {
    event.preventDefault();
    const item = findTransaction(view.editingId);
    if (!item) return;

    const amount = Judge.normalizeNumber(el('editAmount').value);
    if (!validAmount(amount)) {
      setError('editError', 'أدخل مبلغًا صحيحًا أكبر من صفر.');
      return;
    }

    const categorySelect = el('editCategory');
    const categoryOptions = Array.from(categorySelect.options).map((option) => option.value);
    const decision = el('editDecision').value;
    const values = {
      amount: roundMoney(amount),
      when: parseDay(el('editDate').value),
      reason: text(el('editNote').value).slice(0, 100),
      source: text(el('editSource').value).slice(0, 80),
      category: categorySelect.value,
      decision: ['pending', 'regret', 'good'].includes(decision) ? decision : 'pending'
    };

    if (item.type === 'expense' && !categoryOptions.includes(values.category)) {
      setError('editError', 'اختر فئة من القائمة.');
      return;
    }

    // الدخل يزيد الرصيد، والمصروف ينقصه؛ لذلك يتغير الاتجاه حسب نوع الحركة.
    const delta = values.amount - item.amount;
    const direction = item.type === 'income' ? 1 : -1;
    const balanceAfter = roundMoney(computeBalance(state) + direction * delta);
    const freeAfter = roundMoney(computeFree(state) + direction * delta);

    if (balanceAfter < 0) {
      askConfirm(
        'هذا التعديل يجعل الرصيد سالبًا بمقدار ' + moneyWithCurrency(Math.abs(balanceAfter)) +
        '. هل تريد المتابعة رغم ذلك؟',
        () => applyEdit(values),
        { label: 'عدّل رغم التحذير' }
      );
      return;
    }

    if (freeAfter < 0) {
      askConfirm(
        'هذا التعديل يمس مبالغ محجوزة لالتزامات أو أهداف بمقدار ' +
        moneyWithCurrency(Math.abs(freeAfter)) + '. هل تريد المتابعة؟',
        () => applyEdit(values),
        { label: 'تابع التعديل' }
      );
      return;
    }

    applyEdit(values);
  }

  function deleteTransaction() {
    const item = findTransaction(view.editingId);
    if (!item) return;

    const balanceAfter = item.type === 'income'
      ? computeBalance(state) - item.amount
      : computeBalance(state) + item.amount;

    const message = item.type === 'income' && balanceAfter < 0
      ? 'حذف هذا الدخل يجعل الرصيد سالبًا بمقدار ' + moneyWithCurrency(Math.abs(balanceAfter)) +
        '. هل تريد الحذف رغم ذلك؟'
      : 'هل تريد حذف هذه الحركة نهائيًا؟';

    askConfirm(message, () => {
      const linkedMonth = item.commitmentId ? monthKey(item.when) : null;
      state.history = state.history.filter((entry) => entry.id !== item.id);
      releaseCommitmentMonth(item.commitmentId, linkedMonth);
      persist();
      closeModal('editModal');
      render(['home', 'analytics', 'decisions', 'ledger', 'pending', 'weekly']);
      showToast('حُذفت الحركة.');
    }, { label: 'حذف الحركة' });
  }

  function setDecision(id, decision) {
    const item = findTransaction(id);
    if (!item || item.type !== 'expense') return;
    item.decision = decision;
    persist();
    render(['ledger', 'analytics', 'decisions', 'home', 'pending', 'weekly']);

    if (decision === 'regret') {
      showToast(CONFIG.catName + ': ' + pickMessageText('regret', {}));
    } else if (decision === 'good') {
      showToast(CONFIG.catName + ': ' + pickMessageText('noRegret', {}));
    }
  }

  // ============ الميزانية ============

  function openBudgetModal() {
    const categories = allCategories();
    setHtml('budgetFields', categories.map((category) => {
      return '<label>' + escapeHtml(category) +
        '<input data-budget="' + escapeHtml(category) + '" inputmode="decimal" value="' +
        (state.budgets[category] ? String(state.budgets[category]) : '') + '"></label>';
    }).join(''));
    openModal('budgetModal');
  }

  function submitBudget(event) {
    event.preventDefault();
    const budgets = {};
    document.querySelectorAll('[data-budget]').forEach((input) => {
      const amount = Judge.normalizeNumber(input.value);
      if (validAmount(amount)) {
        budgets[input.dataset.budget] = roundMoney(amount);
      }
    });
    state.budgets = budgets;
    persist();
    closeModal('budgetModal');
    render(['analytics']);
    showToast('حُفظت ميزانية الشهر.');
  }

  // ============ الأهداف ============

  function openGoalModal() {
    const form = el('goalForm');
    if (form) form.reset();
    setError('goalError', '');
    openModal('goalModal');
  }

  function submitGoal(event) {
    event.preventDefault();
    const name = text(el('goalName').value).slice(0, 60);
    const target = Judge.normalizeNumber(el('goalTarget').value);
    if (!name) {
      setError('goalError', 'اكتب اسمًا واضحًا للهدف.');
      return;
    }
    if (!validAmount(target)) {
      setError('goalError', 'أدخل مبلغًا صحيحًا للهدف.');
      return;
    }

    state.goals.push({
      id: uid('goal'),
      name,
      target: roundMoney(target),
      saved: 0,
      date: /^\d{4}-\d{2}-\d{2}$/.test(el('goalDate').value) ? el('goalDate').value : ''
    });
    persist();
    closeModal('goalModal');
    render(['goals', 'home']);
    showToast('أُضيف الهدف. الآن لكل مبلغ وجهة.');
  }

  function findGoal(id) {
    return state.goals.find((goal) => goal.id === id) || null;
  }

  function openFundsModal(goalId, mode) {
    const goal = findGoal(goalId);
    if (!goal) return;
    view.fundsGoalId = goalId;
    view.fundsMode = mode;

    const isDeposit = mode === 'deposit';
    setText('fundsTitle', isDeposit ? 'إضافة مبلغ إلى الهدف' : 'سحب مبلغ من الهدف');
    setText('fundsHint', isDeposit
      ? 'المتاح الآن: ' + moneyWithCurrency(computeFree(state)) + ' — المتبقي للهدف: ' +
        moneyWithCurrency(Math.max(0, goal.target - goal.saved))
      : 'المدخر في الهدف: ' + moneyWithCurrency(goal.saved)
    );
    el('fundsAmount').value = '';
    setError('fundsError', '');
    openModal('fundsModal');
  }

  function submitFunds(event) {
    event.preventDefault();
    const goal = findGoal(view.fundsGoalId);
    if (!goal) return;

    const amount = Judge.normalizeNumber(el('fundsAmount').value);
    if (!validAmount(amount)) {
      setError('fundsError', 'أدخل مبلغًا صحيحًا أكبر من صفر.');
      return;
    }

    if (view.fundsMode === 'deposit') {
      const available = computeFree(state);
      if (amount > available) {
        setError('fundsError', 'المتاح للادخار الآن هو ' + moneyWithCurrency(Math.max(0, available)) + ' فقط.');
        return;
      }
      if (amount > goal.target - goal.saved) {
        setError('fundsError', 'المبلغ أكبر من المتبقي للهدف: ' + moneyWithCurrency(goal.target - goal.saved) + '.');
        return;
      }
      goal.saved = roundMoney(goal.saved + amount);
    } else {
      if (amount > goal.saved) {
        setError('fundsError', 'لا يمكن سحب أكثر من المدخر: ' + moneyWithCurrency(goal.saved) + '.');
        return;
      }
      goal.saved = roundMoney(goal.saved - amount);
    }

    const complete = goal.saved >= goal.target;
    persist();
    closeModal('fundsModal');
    render(['goals', 'home']);
    if (view.fundsMode === 'deposit' && complete) {
      showToast(CONFIG.catName + ': تحقق الهدف 🎉 — سأقفز فوق الدفتر احتفالًا.');
    } else {
      showToast(view.fundsMode === 'deposit' ? 'أُضيف المبلغ إلى الهدف.' : 'سُحب المبلغ وأصبح متاحًا.');
    }
  }

  function deleteGoal(id) {
    const goal = findGoal(id);
    if (!goal) return;

    const message = goal.saved > 0
      ? 'سيُحذف هدف «' + goal.name + '»، وسيعود المبلغ المدخر ' +
        moneyWithCurrency(goal.saved) + ' إلى المتاح. هل تريد المتابعة؟'
      : 'هل تريد حذف هدف «' + goal.name + '»؟';

    askConfirm(message, () => {
      state.goals = state.goals.filter((entry) => entry.id !== id);
      persist();
      render(['goals', 'home']);
      showToast('حُذف الهدف.');
    }, { label: 'حذف الهدف' });
  }

  // ============ الالتزامات ============

  function openCommitmentModal(id) {
    view.editingCommitmentId = null;
    const form = el('commitmentForm');
    if (form) form.reset();
    setError('commitmentError', '');

    fillCategorySelect('commitmentCategory', 'ضروريات أخرى');

    if (id) {
      const commitment = state.commitments.find((item) => item.id === id);
      if (!commitment) return;
      view.editingCommitmentId = id;
      setText('commitmentModalTitle', 'تعديل الالتزام');
      el('commitmentName').value = commitment.name;
      el('commitmentAmount').value = String(commitment.amount);
      el('commitmentDay').value = String(commitment.day);
      fillCategorySelect('commitmentCategory', commitment.category);
    } else {
      setText('commitmentModalTitle', 'التزام جديد');
    }

    openModal('commitmentModal');
  }

  function submitCommitment(event) {
    event.preventDefault();
    const name = text(el('commitmentName').value).slice(0, 60);
    const amount = Judge.normalizeNumber(el('commitmentAmount').value);
    const day = Number(el('commitmentDay').value);
    const category = el('commitmentCategory').value;

    if (!name) {
      setError('commitmentError', 'اكتب اسم الالتزام.');
      return;
    }
    if (!validAmount(amount)) {
      setError('commitmentError', 'أدخل مبلغًا صحيحًا.');
      return;
    }
    if (!Number.isInteger(day) || day < 1 || day > 31) {
      setError('commitmentError', 'يوم الاستحقاق بين 1 و31.');
      return;
    }
    if (!category) {
      setError('commitmentError', 'اختر فئة للالتزام.');
      return;
    }

    if (view.editingCommitmentId) {
      const commitment = state.commitments.find((item) => item.id === view.editingCommitmentId);
      if (commitment) {
        commitment.name = name;
        commitment.amount = roundMoney(amount);
        commitment.day = day;
        commitment.category = category;
      }
      showToast('حُدّث الالتزام.');
    } else {
      state.commitments.push({
        id: uid('commitment'),
        name,
        amount: roundMoney(amount),
        day,
        category,
        paidMonths: []
      });
      showToast('أُضيف الالتزام إلى الخطة.');
    }

    persist();
    closeModal('commitmentModal');
    render(['commitments', 'home']);
  }

  function payCommitment(id) {
    const commitment = state.commitments.find((item) => item.id === id);
    if (!commitment) return;

    const month = monthKey(Date.now());
    if (!Array.isArray(commitment.paidMonths)) commitment.paidMonths = [];
    if (commitment.paidMonths.includes(month)) {
      showToast('هذا الالتزام مدفوع بالفعل هذا الشهر.');
      return;
    }

    const record = () => {
      state.history.push({
        id: uid('tx'),
        type: 'expense',
        amount: commitment.amount,
        category: commitment.category,
        reason: 'التزام: ' + commitment.name,
        when: parseDay(dayKey(Date.now())),
        createdAt: Date.now(),
        decision: 'pending',
        commitmentId: commitment.id
      });
      commitment.paidMonths.push(month);
      persist();
      render(['commitments', 'home', 'analytics', 'decisions', 'ledger', 'pending', 'weekly']);
      showToast('سُجّل دفع «' + commitment.name + '» لهذا الشهر.');
    };

    if (commitment.amount > computeBalance(state)) {
      askConfirm(
        'قيمة الالتزام ' + moneyWithCurrency(commitment.amount) +
        ' أكبر من رصيدك الحالي. سيصبح الرصيد سالبًا. هل تريد تسجيل الدفع رغم ذلك؟',
        record,
        { label: 'سجّل الدفع' }
      );
      return;
    }

    record();
  }

  function deleteCommitment(id) {
    const commitment = state.commitments.find((item) => item.id === id);
    if (!commitment) return;
    askConfirm('هل تريد حذف الالتزام «' + commitment.name + '»؟', () => {
      state.commitments = state.commitments.filter((item) => item.id !== id);
      persist();
      render(['commitments', 'home']);
      showToast('حُذف الالتزام.');
    }, { label: 'حذف الالتزام' });
  }

  // ============ الإعدادات والنسخ الاحتياطي ============

  function fillCurrencySelect(selectId, selected) {
    const select = el(selectId);
    if (!select) return;
    const list = CONFIG.currencies;
    select.innerHTML = list.map((currency) =>
      '<option value="' + escapeHtml(currency) + '">' + escapeHtml(currency) + '</option>'
    ).join('');
    // العملة المخصصة تظهر كخيار «عملة أخرى» مع تعبئة حقلها النصي.
    select.value = list.includes(selected) ? selected : 'عملة أخرى';
  }

  function fillCategorySelect(selectId, selected) {
    const select = el(selectId);
    if (!select) return;
    const list = allCategories();
    if (selected && !list.includes(selected)) list.unshift(selected);
    select.innerHTML = list.map((category) =>
      '<option value="' + escapeHtml(category) + '">' + escapeHtml(category) + '</option>'
    ).join('');
    select.value = selected || list[0];
  }

  function renderCategoryList() {
    if (state.customCategories.length === 0) {
      setHtml('categoryList', '<p class="muted small">لا توجد فئات مخصصة بعد.</p>');
      return;
    }
    setHtml('categoryList', state.customCategories.map((category) =>
      '<div class="settings-row"><span>' + escapeHtml(category) + '</span>' +
      '<button type="button" class="tiny-delete" data-action="deleteCategory" data-category="' +
      escapeHtml(category) + '" aria-label="حذف الفئة ' + escapeHtml(category) + '">حذف</button></div>'
    ).join(''));
  }

  function renderArchiveList() {
    const archives = Array.isArray(state.archives) ? state.archives : [];
    if (archives.length === 0) {
      setHtml('archiveList', '<p class="muted small">لا توجد فترات مؤرشفة بعد.</p>');
      return;
    }
    setHtml('archiveList', archives.map((archive) => {
      const count = archive.history.length;
      return '<div class="settings-row archive-row"><span>أُغلقت في ' + formatDate(archive.closedAt) +
        ' · ' + count + ' حركة · الرصيد الختامي: ' + moneyWithCurrency(archive.closingBalance) +
        '</span><button type="button" class="ghost archive-export" data-action="exportArchive" data-id="' +
        escapeHtml(archive.id) + '">تصدير</button></div>';
    }).join(''));
  }

  function downloadJson(data, filename) {
    const payload = JSON.stringify(data, null, 2);
    const blob = new Blob([payload], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportArchive(id) {
    const archive = (state.archives || []).find((item) => item.id === id);
    if (!archive) return;
    downloadJson({
      currency: state.currency,
      name: state.name,
      archive
    }, 'nadam-wallet-period-' + dayKey(archive.closedAt) + '.json');
    showToast('نُزّلت نسخة من الفترة المؤرشفة.');
  }

  function closeCurrentPeriod() {
    const count = state.history.length;
    askConfirm(
      'سيُنقل الرصيد الختامي (' + moneyWithCurrency(computeBalance(state)) + ') لبداية الفترة الجديدة، وتُؤرشف ' +
      count + ' حركة. ستُصفّر ميزانيات الفترة فقط، وستبقى الأهداف والالتزامات كما هي.',
      () => {
        state = archiveCurrentPeriod(state);
        if (!persist()) return;
        renderArchiveList();
        render('all');
        showToast('أُغلقت الفترة وبدأت فترة جديدة.');
      },
      { label: 'أغلق الفترة', title: 'بدء فترة جديدة' }
    );
  }

  function addCustomCategory() {
    const input = el('customCategoryInput');
    const name = text(input.value).slice(0, 40);
    if (!name) {
      setError('categoryError', 'اكتب اسمًا للفئة.');
      return;
    }
    if (allCategories().includes(name)) {
      setError('categoryError', 'هذه الفئة موجودة بالفعل.');
      return;
    }
    state.customCategories.push(name);
    persist();
    input.value = '';
    setError('categoryError', '');
    renderCategoryList();
    fillCategorySelect('category', el('category').value);
    fillCategorySelect('commitmentCategory', 'ضروريات أخرى');
    render(['analytics']);
    showToast('أُضيفت الفئة «' + name + '».');
  }

  function deleteCustomCategory(name) {
    askConfirm('هل تريد حذف الفئة «' + name + '»؟ الحركات القديمة ستبقى محفوظة باسمها.', () => {
      state.customCategories = state.customCategories.filter((item) => item !== name);
      persist();
      renderCategoryList();
      fillCategorySelect('category', el('category').value);
      render(['analytics']);
      showToast('حُذفت الفئة.');
    }, { label: 'حذف الفئة' });
  }

  function openSettings() {
    el('settingsName').value = state.name;
    fillCurrencySelect('settingsCurrency', state.currency);
    const isCustom = !CONFIG.currencies.includes(state.currency);
    show('settingsCustomCurrencyField', isCustom);
    el('settingsCustomCurrency').value = isCustom ? state.currency : '';
    setError('settingsError', '');
    renderCategoryList();
    renderArchiveList();
    updatePinUi();
    openModal('settingsModal');
  }

  function submitSettings(event) {
    event.preventDefault();
    const name = text(el('settingsName').value).slice(0, 35);
    const selected = el('settingsCurrency').value;
    const currency = selected === 'عملة أخرى'
      ? text(el('settingsCustomCurrency').value).slice(0, 25)
      : selected;

    if (!name) {
      setError('settingsError', 'الاسم مطلوب.');
      return;
    }
    if (!currency) {
      setError('settingsError', 'اكتب اسم العملة.');
      return;
    }

    state.name = name;
    state.currency = currency;
    persist();
    setError('settingsError', '');
    closeModal('settingsModal');
    render('all');
    showToast('حُفظت الإعدادات.');
  }

  function exportBackup() {
    // لا نصدّر بصمة القفل أو ملحها: النسخة قد تُشارَك، والبيانات المالية وحدها هي المطلوبة.
    const exported = Object.assign({}, state);
    delete exported.pinHash;
    delete exported.pinSalt;
    delete exported.pinIterations;
    downloadJson(exported, 'nadam-wallet-backup-' + dayKey(Date.now()) + '.json');
    showToast('نُزّلت نسخة احتياطية من بياناتك.');
  }

  function importBackupFile(file) {
    if (!file) return;
    if (file.size > MAX_BACKUP_SIZE) {
      showToast('الملف كبير جدًا. اختر ملف نسخة احتياطية صغيرًا.');
      return;
    }

    file.text()
      .then((content) => {
        let raw;
        try {
          raw = JSON.parse(content);
        } catch (error) {
          showToast('الملف ليس JSON صالحًا.');
          return;
        }
        if (!raw || !Array.isArray(raw.history) || !raw.currency) {
          showToast('الملف لا يبدو نسخة احتياطية من محفظة الندم.');
          return;
        }

        const imported = migrateState(raw);
        if (!imported) {
          showToast('تعذّر قراءة بيانات النسخة الاحتياطية.');
          return;
        }
        // النسخ الاحتياطية لا تحمل قفلًا؛ نضمن ألا يفرض ملف خارجي قفلًا على المستخدم.
        imported.pinHash = null;
        imported.pinSalt = null;
        imported.pinIterations = 0;

        askConfirm(
          'سيُستبدل كل ما في التطبيق الحالي ببيانات النسخة الاحتياطية (' +
          imported.history.length + ' حركة). هل تريد المتابعة؟',
          () => {
            state = imported;
            persist();
            closeModal('settingsModal', { restoreFocus: false });
            refreshAfterRestore();
            showToast('استُعيدت النسخة الاحتياطية بنجاح.');
          },
          { label: 'استورد واستبدل' }
        );
      })
      .catch(() => showToast('تعذّر قراءة الملف.'));
  }

  function refreshAfterRestore() {
    if (!state.name) {
      showSetupScreen();
      return;
    }
    showAppScreen();
    render('all');
    updatePinUi();
  }

  function resetEverything() {
    askConfirm(
      'سيُحذف كل شيء: الحركات، الأهداف، الالتزامات، والميزانية. لا يمكن التراجع. هل أنت متأكد؟',
      () => {
        try {
          localStorage.removeItem(CONFIG.storageKey);
          localStorage.removeItem(CONFIG.storageKey + '-corrupt');
          localStorage.removeItem(CONFIG.recentMessagesKey);
          localStorage.removeItem(THEME_KEY);
        } catch (error) {
          // الحذف قد يفشل في المتصفحات المقيدة، وإعادة التحميل ستُظهر الحالة الحقيقية.
        }
        window.location.reload();
      },
      { label: 'احذف كل البيانات', title: 'حذف نهائي' }
    );
  }

  // ============ قفل PIN ============

  function toAsciiDigits(value) {
    return String(value)
      .replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
      .replace(/[۰-۹]/g, (digit) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)))
      .replace(/[０-９]/g, (digit) => String('０１２３４５６７８９'.indexOf(digit)));
  }

  function bytesToHex(bytes) {
    return Array.from(new Uint8Array(bytes))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  }

  function hexToBytes(hex) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    }
    return bytes;
  }

  function randomSalt() {
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    return bytesToHex(bytes);
  }

  // البصمة القديمة (SHA-256) تبقى للقراءة فقط حتى يُفتح القفل مرة واحدة ثم تُرقّى.
  async function legacyPinHash(pin) {
    const bytes = new TextEncoder().encode('nadam-wallet:' + pin);
    const digest = await window.crypto.subtle.digest('SHA-256', bytes);
    return bytesToHex(digest);
  }

  async function derivePinHash(pin, salt, iterations) {
    const keyMaterial = await window.crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(pin),
      'PBKDF2',
      false,
      ['deriveBits']
    );
    const bits = await window.crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt: hexToBytes(salt),
        iterations,
        hash: 'SHA-256'
      },
      keyMaterial,
      256
    );
    return bytesToHex(bits);
  }

  function hashesEqual(left, right) {
    if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) {
      return false;
    }
    let difference = 0;
    for (let index = 0; index < left.length; index += 1) {
      difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
    }
    return difference === 0;
  }

  async function verifyPin(pin) {
    if (!window.crypto || !window.crypto.subtle) {
      throw new Error('unsupported');
    }
    if (state.pinSalt && state.pinIterations) {
      const hash = await derivePinHash(pin, state.pinSalt, state.pinIterations);
      return hashesEqual(hash, state.pinHash);
    }
    const legacy = await legacyPinHash(pin);
    if (!hashesEqual(legacy, state.pinHash)) {
      return false;
    }
    // ترقية شفافة للبصمة القديمة بعد أول فتح ناجح.
    const salt = randomSalt();
    state.pinSalt = salt;
    state.pinIterations = PIN_ITERATIONS;
    state.pinHash = await derivePinHash(pin, salt, PIN_ITERATIONS);
    persist();
    return true;
  }

  function rememberPinFailure() {
    pinGuard.failures += 1;
    if (pinGuard.failures >= 5) {
      pinGuard.failures = 0;
      pinGuard.lockedUntil = Date.now() + 30000;
    }
  }

  function pinRateLimited() {
    if (Date.now() < pinGuard.lockedUntil) {
      const seconds = Math.ceil((pinGuard.lockedUntil - Date.now()) / 1000);
      setError('unlockError', 'محاولات كثيرة. انتظر ' + seconds + ' ثانية ثم حاول مجددًا.');
      return true;
    }
    return false;
  }

  function updatePinUi() {
    const hasPin = Boolean(state && state.pinHash);
    show('lockNow', hasPin);
    show('pinDisable', hasPin);
    show('pinCurrentField', hasPin);
    setText('pinStatus', hasPin
      ? 'القفل مفعّل. سيُطلب الرمز عند كل فتح للتطبيق.'
      : 'القفل غير مفعّل. يمكنك إضافة رمز من 4 أرقام لحماية بياناتك.');
  }

  async function savePin(event) {
    event.preventDefault();
    const newPin = toAsciiDigits(el('pinNew').value);
    if (!/^\d{4}$/.test(newPin)) {
      setError('pinError', 'الرمز يجب أن يكون 4 أرقام.');
      return;
    }

    try {
      if (state.pinHash) {
        const currentPin = toAsciiDigits(el('pinCurrent').value);
        if (!(await verifyPin(currentPin))) {
          setError('pinError', 'الرمز الحالي غير صحيح.');
          return;
        }
      }

      const salt = randomSalt();
      state.pinSalt = salt;
      state.pinIterations = PIN_ITERATIONS;
      state.pinHash = await derivePinHash(newPin, salt, PIN_ITERATIONS);
      persist();
      el('pinNew').value = '';
      el('pinCurrent').value = '';
      setError('pinError', '');
      updatePinUi();
      showToast('فُعّل قفل التطبيق.');
    } catch (error) {
      setError('pinError', 'المتصفح لا يدعم التشفير المطلوب. جرّب متصفحًا أحدث.');
    }
  }

  async function disablePin() {
    if (!state.pinHash) return;
    const currentPin = toAsciiDigits(el('pinCurrent').value);
    try {
      if (!(await verifyPin(currentPin))) {
        setError('pinError', 'أدخل الرمز الحالي أولًا لإيقاف القفل.');
        return;
      }
      state.pinHash = null;
      state.pinSalt = null;
      state.pinIterations = 0;
      persist();
      el('pinCurrent').value = '';
      setError('pinError', '');
      updatePinUi();
      showToast('أُوقف قفل التطبيق.');
    } catch (error) {
      setError('pinError', 'تعذّر التحقق من الرمز في هذا المتصفح.');
    }
  }

  function showLockScreen() {
    const lock = el('lockScreen');
    const app = el('app');
    if (!lock) return;
    lock.hidden = false;
    if (app) {
      app.setAttribute('aria-hidden', 'true');
      app.setAttribute('inert', '');
    }
    el('unlockPin').value = '';
    setError('unlockError', '');
    el('unlockPin').focus();
  }

  function hideLockScreen() {
    const lock = el('lockScreen');
    const app = el('app');
    if (!lock) return;
    lock.hidden = true;
    if (app) {
      app.removeAttribute('aria-hidden');
      app.removeAttribute('inert');
    }
  }

  async function unlock(event) {
    event.preventDefault();
    if (pinRateLimited()) return;
    const pin = toAsciiDigits(el('unlockPin').value);
    if (!/^\d{4}$/.test(pin)) {
      setError('unlockError', 'أدخل أربعة أرقام.');
      return;
    }
    try {
      if (!(await verifyPin(pin))) {
        rememberPinFailure();
        setError('unlockError', 'الرمز غير صحيح.');
        el('unlockPin').value = '';
        return;
      }
      pinGuard.failures = 0;
      hideLockScreen();
      showAppScreen();
      render('all');
      updatePinUi();
    } catch (error) {
      setError('unlockError', 'تعذّر التحقق في هذا المتصفح.');
    }
  }

  // ============ المظهر ============

  function readTheme() {
    try {
      return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light';
    } catch (error) {
      return 'light';
    }
  }

  function applyTheme(theme) {
    const mode = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = mode;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = mode === 'dark' ? '#141a25' : '#fff7eb';
    const button = el('themeToggle');
    if (button) {
      const isDark = mode === 'dark';
      button.textContent = isDark ? '☀️' : '🌙';
      button.setAttribute('aria-label', isDark ? 'تفعيل الوضع الفاتح' : 'تفعيل الوضع الداكن');
      button.setAttribute('aria-pressed', String(isDark));
    }
  }

  function toggleTheme() {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch (error) {
      // تفضيل المظهر ليس بيانات حرجة؛ يكفي تطبيقه لهذه الجلسة.
    }
  }

  // ============ تقرير PDF ============

  function printReport() {
    let from = parseDay(el('reportFrom').value || dayKey(Date.now()));
    let to = parseDay(el('reportTo').value || dayKey(Date.now()));
    if (from > to) {
      const swapped = from;
      from = to;
      to = swapped;
    }
    to += MS_DAY;

    const rows = state.history
      .filter((item) => item.when >= from && item.when < to)
      .sort((a, b) => b.when - a.when || b.createdAt - a.createdAt);

    const expenses = sum(rows.filter((item) => item.type === 'expense').map((item) => item.amount));
    const incomes = sum(rows.filter((item) => item.type === 'income').map((item) => item.amount));

    const body = rows.map((item) => {
      return '<tr><td>' + formatDate(item.when) + '</td>' +
        '<td>' + (item.type === 'income' ? 'دخل' : 'مصروف') + '</td>' +
        '<td>' + escapeHtml(item.type === 'income' ? item.source || 'دخل' : item.category) + '</td>' +
        '<td>' + money(item.amount) + '</td>' +
        '<td>' + escapeHtml(item.reason || '') + '</td>' +
        '<td>' + (item.type === 'income' ? '—' : decisionLabel(item.decision)) + '</td></tr>';
    }).join('');

    setHtml('printReport',
      '<h1>محفظة الندم — تقرير مالي</h1>' +
      '<p>من ' + formatDate(from) + ' إلى ' + formatDate(to - MS_DAY) + ' · ' + escapeHtml(state.name) + '</p>' +
      '<table><thead><tr><th>الدخل</th><th>المصروف</th><th>الصافي</th><th>الرصيد</th><th>المتاح</th></tr></thead>' +
      '<tbody><tr><td>' + money(incomes) + '</td><td>' + money(expenses) + '</td><td>' +
      money(incomes - expenses) + '</td><td>' + money(computeBalance(state)) + '</td><td>' +
      money(computeFree(state)) + '</td></tr></tbody></table>' +
      '<h2>الحركات (' + rows.length + ')</h2>' +
      '<table><thead><tr><th>التاريخ</th><th>النوع</th><th>الفئة أو المصدر</th><th>المبلغ</th>' +
      '<th>الملاحظة</th><th>القرار</th></tr></thead><tbody>' +
      (body || '<tr><td colspan="6">لا توجد حركات في هذا النطاق.</td></tr>') +
      '</tbody></table>' +
      '<h2>الأهداف والالتزامات</h2>' +
      '<table><thead><tr><th>النوع</th><th>الاسم</th><th>القيمة</th><th>الحالة</th></tr></thead><tbody>' +
      state.goals.map((goal) => '<tr><td>هدف</td><td>' + escapeHtml(goal.name) + '</td><td>' +
        money(goal.saved) + ' / ' + money(goal.target) + '</td><td>' +
        (goal.saved >= goal.target ? 'تحقق' : 'قيد التوفير') + '</td></tr>').join('') +
      state.commitments.map((commitment) => '<tr><td>التزام</td><td>' + escapeHtml(commitment.name) +
        '</td><td>' + money(commitment.amount) + '</td><td>' +
        dueInfo(commitment).label + '</td></tr>').join('') +
      '</tbody></table>'
    );

    window.print();
  }

  // ============ الشاشات والتبويبات ============

  function showSetupScreen() {
    const setup = el('setup');
    const shell = el('appShell');
    setHtml('setupCat', catSVG('happy'));
    if (setup) setup.classList.add('active');
    if (shell) shell.classList.remove('active');

    // إن وُجدت بيانات قديمة بلا اسم، نحافظ عليها ونعبّئ الحقول بدل إنشاء محفظة فارغة.
    if (state) {
      if (!el('userName').value) el('userName').value = state.name || '';
      if (!el('openingBalance').value) el('openingBalance').value = String(state.openingBalance || '');
      fillCurrencySelect('currency', state.currency);
      show('customCurrencyField', el('currency').value === 'عملة أخرى');
      if (el('currency').value === 'عملة أخرى') {
        el('customCurrency').value = state.currency;
      }
    }
  }

  function showAppScreen() {
    const setup = el('setup');
    const shell = el('appShell');
    if (setup) setup.classList.remove('active');
    if (shell) shell.classList.add('active');
  }

  function switchTab(tab) {
    document.querySelectorAll('[data-tab]').forEach((button) => {
      const active = button.dataset.tab === tab;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
    });
    document.querySelectorAll('.tab-panel').forEach((panel) => {
      panel.classList.toggle('active', panel.id === 'panel-' + tab);
    });

    if (tab === 'home') render(['home', 'pending', 'weekly']);
    if (tab === 'analytics') render(['analytics', 'decisions']);
    if (tab === 'goals') render(['goals', 'commitments']);
    if (tab === 'ledger') render(['ledger']);
    const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
  }

  // ============ الإقلاع ============

  function fillSetupSelects() {
    fillCurrencySelect('currency', CONFIG.currencies[0]);
    fillCategorySelect('category', '');
  }

  function submitSetup(event) {
    event.preventDefault();
    const name = text(el('userName').value).slice(0, 35);
    const opening = Judge.normalizeNumber(el('openingBalance').value);
    const selected = el('currency').value;
    const currency = selected === 'عملة أخرى'
      ? text(el('customCurrency').value).slice(0, 25)
      : selected;

    if (!name) {
      setError('setupError', 'اكتب اسمك أولًا.');
      return;
    }
    if (!Number.isFinite(opening) || opening < 0 || opening > MAX_AMOUNT) {
      setError('setupError', 'أدخل رصيدًا افتتاحيًا صحيحًا (صفر أو أكثر).');
      return;
    }
    if (!currency) {
      setError('setupError', 'اكتب اسم العملة.');
      return;
    }

    state = state || createEmptyState();
    state.name = name;
    state.currency = currency;
    state.openingBalance = roundMoney(opening);
    persist();
    setError('setupError', '');
    showAppScreen();
    render('all');
    switchTab('home');
  }

  function bindStaticEvents() {
    el('setupForm').addEventListener('submit', submitSetup);
    el('currency').addEventListener('change', () => {
      show('customCurrencyField', el('currency').value === 'عملة أخرى');
    });

    el('settingsOpen').addEventListener('click', openSettings);
    el('themeToggle').addEventListener('click', toggleTheme);
    el('lockNow').addEventListener('click', showLockScreen);
    el('unlockForm').addEventListener('submit', unlock);

    document.querySelectorAll('[data-tab]').forEach((button) => {
      button.addEventListener('click', () => switchTab(button.dataset.tab));
    });

    el('spendOpen').addEventListener('click', openSpendModal);
    el('incomeOpen').addEventListener('click', openIncomeModal);
    el('spendForm').addEventListener('submit', submitSpend);
    el('incomeForm').addEventListener('submit', submitIncome);

    el('reviewBack').addEventListener('click', cancelReviewedSpend);
    el('reviewConfirm').addEventListener('click', confirmReviewedSpend);
    el('reviewDone').addEventListener('click', closeReview);

    document.querySelectorAll('.period').forEach((button) => {
      button.addEventListener('click', () => {
        view.period = button.dataset.period;
        document.querySelectorAll('.period').forEach((item) => {
          item.classList.toggle('active', item === button);
        });
        render(['analytics']);
      });
    });

    el('budgetOpen').addEventListener('click', openBudgetModal);
    el('budgetForm').addEventListener('submit', submitBudget);
    el('budgetList').addEventListener('click', (event) => {
      if (event.target.closest('[data-action="budget"]')) openBudgetModal();
    });

    el('goalOpen').addEventListener('click', openGoalModal);
    el('goalForm').addEventListener('submit', submitGoal);
    el('goalList').addEventListener('click', handleGoalAction);
    el('fundsForm').addEventListener('submit', submitFunds);

    el('commitmentOpen').addEventListener('click', () => openCommitmentModal(null));
    el('commitmentForm').addEventListener('submit', submitCommitment);
    el('commitmentList').addEventListener('click', handleCommitmentAction);

    el('editForm').addEventListener('submit', submitEdit);
    el('deleteTransaction').addEventListener('click', deleteTransaction);

    el('typeFilter').addEventListener('change', () => {
      view.ledgerPage = 1;
      render(['ledger']);
    });
    el('searchFilter').addEventListener('input', () => {
      view.ledgerPage = 1;
      render(['ledger']);
    });
    el('loadMore').addEventListener('click', () => {
      view.ledgerPage += 1;
      render(['ledger']);
    });
    el('activityList').addEventListener('click', handleLedgerAction);
    el('pendingList').addEventListener('click', handleLedgerAction);

    el('printPdf').addEventListener('click', printReport);

    el('settingsForm').addEventListener('submit', submitSettings);
    el('settingsCurrency').addEventListener('change', () => {
      show('settingsCustomCurrencyField', el('settingsCurrency').value === 'عملة أخرى');
    });
    el('addCategory').addEventListener('click', addCustomCategory);
    el('categoryList').addEventListener('click', (event) => {
      const button = event.target.closest('[data-action="deleteCategory"]');
      if (button) deleteCustomCategory(button.dataset.category);
    });
    el('closePeriod').addEventListener('click', closeCurrentPeriod);
    el('archiveList').addEventListener('click', (event) => {
      const button = event.target.closest('[data-action="exportArchive"]');
      if (button) exportArchive(button.dataset.id);
    });
    el('exportBackup').addEventListener('click', exportBackup);
    el('importBackupOpen').addEventListener('click', () => el('importBackup').click());
    el('importBackup').addEventListener('change', (event) => {
      importBackupFile(event.target.files[0]);
      event.target.value = '';
    });
    el('pinForm').addEventListener('submit', savePin);
    el('pinDisable').addEventListener('click', disablePin);
    el('resetSettings').addEventListener('click', resetEverything);

    el('confirmOk').addEventListener('click', () => {
      const action = view.confirmAction;
      view.confirmAction = null;
      closeModal('confirmModal', { restoreFocus: false });
      if (action) action();
    });

    document.querySelectorAll('[data-close]').forEach((button) => {
      button.addEventListener('click', () => {
        const modal = button.closest('.modal');
        if (!modal) return;
        if (modal.id === 'reviewModal') {
          closeReview();
        } else if (modal.id === 'confirmModal') {
          view.confirmAction = null;
          closeModal('confirmModal');
        } else {
          closeModal(modal.id);
        }
      });
    });

    document.querySelectorAll('.modal').forEach((modal) => {
      modal.addEventListener('click', (event) => {
        if (event.target === modal) closeModal(modal.id);
      });
    });

    document.addEventListener('keydown', (event) => {
      const lock = el('lockScreen');
      if (lock && !lock.hidden) {
        if (event.key === 'Tab') keepFocusInside(lock, event);
        return;
      }
      if (event.key === 'Escape' && view.modalStack.length > 0) {
        event.preventDefault();
        const top = view.modalStack[view.modalStack.length - 1];
        closeModal(top);
        return;
      }
      if (event.key === 'Tab') trapFocus(event);
    });

    window.addEventListener('storage', (event) => {
      if (event.key === THEME_KEY) {
        applyTheme(readTheme());
        return;
      }
      if (event.key !== CONFIG.storageKey) return;
      if (event.newValue === null) {
        state = null;
        showSetupScreen();
        return;
      }
      const next = loadState();
      if (!next) return;
      state = next;
      if (!state.name) {
        showSetupScreen();
        return;
      }
      showAppScreen();
      render('all');
      updatePinUi();
      if (state.pinHash) showLockScreen();
      showToast('تم تحديث البيانات من نافذة أخرى.');
    });
  }

  function handleLedgerAction(event) {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const action = button.dataset.action;
    if (action === 'edit') openEdit(button.dataset.id);
    if (action === 'decision') setDecision(button.dataset.id, button.dataset.decision);
  }

  function handleGoalAction(event) {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const action = button.dataset.action;
    if (action === 'deposit') openFundsModal(button.dataset.id, 'deposit');
    if (action === 'withdraw') openFundsModal(button.dataset.id, 'withdraw');
    if (action === 'deleteGoal') deleteGoal(button.dataset.id);
  }

  function handleCommitmentAction(event) {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const action = button.dataset.action;
    if (action === 'payCommitment') payCommitment(button.dataset.id);
    if (action === 'editCommitment') openCommitmentModal(button.dataset.id);
    if (action === 'deleteCommitment') deleteCommitment(button.dataset.id);
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    if (!/^https?:$/.test(window.location.protocol)) return;
    navigator.serviceWorker.register('service-worker.js').catch(() => {
      // العمل بدون إنترنت ميزة إضافية؛ فشل التسجيل لا يعطل التطبيق.
    });
  }

  function start() {
    if (!el('appShell')) return;

    applyTheme(readTheme());
    state = loadState();
    bindStaticEvents();
    fillSetupSelects();
    fillCategorySelect('commitmentCategory', 'ضروريات أخرى');
    fillCurrencySelect('settingsCurrency', state ? state.currency : CONFIG.currencies[0]);

    const today = dayKey(Date.now());
    el('reportFrom').value = monthKey(Date.now()) + '-01';
    el('reportTo').value = today;

    if (!state) {
      showSetupScreen();
      registerServiceWorker();
      return;
    }

    if (!state.name) {
      showSetupScreen();
      registerServiceWorker();
      return;
    }

    showAppScreen();
    updatePinUi();

    // لا نصيّر البيانات المالية قبل فتح القفل؛ القفل ليس مجرد غطاء بصري.
    if (state.pinHash) {
      showLockScreen();
      registerServiceWorker();
      return;
    }

    render('all');
    registerServiceWorker();
  }

  // ننشر الدوال الخالصة للاختبارات في tests.html
  window.WalletCore = {
    createEmptyState,
    migrateState,
    computeBalance,
    computeCommitmentReserved,
    computeReserved,
    computeFree,
    monthSpentByCategory,
    totalIncomeInMonth,
    archiveCurrentPeriod,
    monthKey,
    dayKey,
    parseDay,
    roundMoney,
    homeMood,
    dueInfo,
    periodRange,
    inRange
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
