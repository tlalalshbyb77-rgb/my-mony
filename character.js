/*
 * شخصية «الأستاذ مياو»: رسم SVG واحد يتغير وجهه حسب التعبير.
 */
(function () {
  'use strict';

  const EXPRESSION_LABELS = {
    happy: 'سعيد',
    worried: 'قلق',
    sad: 'حزين',
    crying: 'يبكي',
    shocked: 'مصدوم',
    celebrate: 'يحتفل'
  };

  function catSVG(expression) {
    const mood = EXPRESSION_LABELS[expression] ? expression : 'happy';
    const config = window.WALLET_CONFIG || {};
    const catName = config.catName || 'الأستاذ مياو';
    const label = catName + ' ' + EXPRESSION_LABELS[mood];

    const faces = {
      happy: '<path class="brow" d="M105 100q14-10 28 0M167 100q14-10 28 0"/><path class="mouth" d="M138 142q14 16 28 0"/>',
      worried: '<path class="brow" d="M105 98l27 7M168 105l27-7"/><path class="mouth" d="M139 148q13-9 26 0"/>',
      sad: '<path class="brow" d="M104 108l28-9M168 99l28 9"/><path class="mouth" d="M139 151q13-12 27 0"/>',
      crying: '<path class="brow" d="M104 108l28-9M168 99l28 9"/><path class="mouth" d="M139 151q13-12 27 0"/><path class="tear" d="M116 132q-11 17 0 22q11-5 0-22M186 132q-11 17 0 22q11-5 0-22"/>',
      shocked: '<path class="brow" d="M104 94l28-5M168 89l28 5"/><ellipse class="mouth" cx="152" cy="148" rx="9" ry="13"/>',
      celebrate: '<path class="brow" d="M105 98q14-12 28 0M167 98q14-12 28 0"/><path class="mouth" d="M136 139q16 22 32 0"/>'
    };

    return '<svg class="cat ' + mood + '" viewBox="0 0 300 320" role="img" aria-label="' + label + '">' +
      '<g class="tail"><path d="M218 245q58 5 36-60q-9-19-21-3q25 46-24 35"/></g>' +
      '<path class="ear" d="M90 93L96 38l44 42M210 93l-6-55l-44 42"/><circle class="head" cx="150" cy="125" r="79"/>' +
      '<g class="eyes"><ellipse cx="119" cy="122" rx="21" ry="26"/><ellipse cx="181" cy="122" rx="21" ry="26"/><circle class="shine" cx="126" cy="113" r="6"/><circle class="shine" cx="188" cy="113" r="6"/></g>' +
      '<g class="glasses"><circle cx="119" cy="122" r="30"/><circle cx="181" cy="122" r="30"/><path d="M149 122h3M89 115l-20-8M211 115l20-8"/></g>' +
      '<path class="nose" d="M146 136q4 5 8 0q-4 7-8 0"/>' +
      (faces[mood] || faces.happy) +
      '<path class="suit" d="M91 224q-15 31-7 70h132q8-39-7-70q-59-32-118 0"/><path class="shirt" d="M132 220l18 35l18-35"/><path class="bow" d="M150 240l-24-12v24zm0 0l24-12v24z"/><circle class="bow" cx="150" cy="240" r="7"/>' +
      '<path class="paw" d="M93 263q-27 5-19 24q17 7 29-11M207 263q27 5 19 24q-17 7-29-11"/>' +
      '</svg>';
  }

  window.catSVG = catSVG;
})();
