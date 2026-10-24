/* يملأ بيانات الدفع من الخادم (.env). عند فتح الصفحة بلا خادم تبقى القيم المكتوبة داخل الصفحة. */
(function(){
  var ar=(document.documentElement.lang||'').indexOf('ar')===0;
  fetch('/api/payment-info',{credentials:'same-origin'}).then(function(r){return r.ok?r.json():null}).then(function(d){
    if(!d||!d.payment) return;
    var p=d.payment;
    function fill(k,v){ if(!v) return; [].forEach.call(document.querySelectorAll('[data-pay="'+k+'"]'),function(el){el.textContent=v}); }
    fill('iban',p.iban); fill('cliq',p.cliqAlias);
    var extra=(ar?' — SWIFT: ':' — SWIFT: ')+p.swift+' — '+(ar?'المستفيد: ':'Beneficiary: ')+p.accountHolder+(p.contactEmail?(' — '+p.contactEmail):'');
    fill('extra',extra);
  }).catch(function(){});
})();
