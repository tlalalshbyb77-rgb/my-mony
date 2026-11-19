/*
 * إعدادات «محفظة الندم».
 * هذا الملف هو المصدر الوحيد للثوابت المشتركة بين المحرك والواجهة.
 */
(function () {
  'use strict';

  const CURRENCIES = [
    'دينار ليبي',
    'ريال سعودي',
    'درهم إماراتي',
    'جنيه مصري',
    'دولار',
    'يورو',
    'عملة أخرى'
  ];

  const CATEGORIES = [
    'أكل ومشروبات',
    'الجيم والصحة',
    'السيارة والمواصلات',
    'صندوق الطوارئ',
    'الحلاقة والعناية',
    'الإنترنت والاتصالات',
    'السكن والفواتير',
    'التسوق',
    'الترفيه',
    'الملابس',
    'الهدايا',
    'ضروريات أخرى'
  ];

  // الفئات التي لا يعاقب عليها المحرك، لأنها احتياج لا رفاهية.
  const NECESSARY_CATEGORIES = [
    'الجيم والصحة',
    'السكن والفواتير',
    'الإنترنت والاتصالات',
    'صندوق الطوارئ',
    'ضروريات أخرى'
  ];

  window.WALLET_CONFIG = {
    version: 4,

    // المفتاح القديم نفسه: تغييره يعني فقدان بيانات المستخدمين الحاليين.
    storageKey: 'nadam-wallet-v1',
    recentMessagesKey: 'nadam-wallet-recent-messages',
    themeKey: 'nadam-wallet-theme',

    catName: 'الأستاذ مياو',
    defaultUserName: 'صديقي',

    // حد عملي يمنع إدخال أرقام ضخمة تُفسد العرض أو الحسابات.
    maxAmount: 1e12,
    // عدد دورات PBKDF2 لحماية رمز القفل. لا يغني عن تشفير البيانات، لكنه يرفع كلفة التخمين.
    pinIterations: 210000,

    currencies: CURRENCIES,
    categories: CATEGORIES,
    necessaryCategories: NECESSARY_CATEGORIES,

    // حدود نسبة المصروف من الرصيد: خفيف، متوسط، ثقيل.
    thresholds: [0.05, 0.15, 0.35],

    // الدينار بثلاث خانات عشرية، وبقية العملات بخانتين.
    decimalsFor(currencyName) {
      return String(currencyName || '').includes('دينار') ? 3 : 2;
    },

    isNecessary(category) {
      return NECESSARY_CATEGORIES.includes(category);
    }
  };
})();
