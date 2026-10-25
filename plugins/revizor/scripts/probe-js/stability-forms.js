// Revizor built-in probe stability-forms.js: the body of an async function (result via return; ARGS = --js-args JSON, {} by default).
// Run: node "<ROOT>/scripts/probe.mjs" --run "<RUN>" --pid <pid> --width 1440 --js "<ROOT>/scripts/probe-js/stability-forms.js" --no-shot
// how forms would submit natively if the site script did not run: action, method, submit buttons, required fields.
// Nothing is clicked or sent. Run twice: as is and with --block on the main script, then compare.
const q = (s, r) => Array.from((r || document).querySelectorAll(s));
const forms = q('form').slice(0, 10).map((f, i) => {
  const fields = Array.from(f.elements).filter(e => /^(INPUT|SELECT|TEXTAREA)$/.test(e.tagName) && !/^(hidden|submit|button|reset|image)$/i.test(e.type));
  const outside = f.id ? q('button[form="' + f.id + '"], input[form="' + f.id + '"]') : [];
  const buttons = q('button, input[type=submit], input[type=image]', f).concat(outside);
  const submits = buttons.filter(b => b.type === 'submit' || b.type === 'image');
  return {
    sel: 'form' + (f.id ? '#' + f.id : ':nth-of-type(' + (i + 1) + ')'),
    action: f.getAttribute('action'), method: (f.getAttribute('method') || 'get').toLowerCase(), novalidate: f.noValidate,
    onsubmit_attr: f.hasAttribute('onsubmit'), fields: fields.length,
    required: fields.filter(e => e.required || e.hasAttribute('pattern') || e.minLength > 0).length,
    contact_fields: fields.filter(e => /tel|email|phone|name|имя|телефон/i.test([e.type, e.name, e.autocomplete, e.placeholder].join(' '))).length,
    submit_buttons: submits.length, other_buttons: buttons.length - submits.length,
  };
});
return { forms };
