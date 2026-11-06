/* يملأ بيانات الدفع من الخادم (متغيرات البيئة PAYMENT_*). لا توجد قيم مكتوبة داخل الصفحات. */
(function(){
  var ar=(document.documentElement.lang||'').indexOf('ar')===0;
  var missing=ar?'غير مضبوط بعد — تواصل مع الإدارة':'not configured yet — contact the administrator';
  function all(k){return [].slice.call(document.querySelectorAll('[data-pay="'+k+'"]'));}
  function fill(k,v){all(k).forEach(function(el){el.textContent=v||missing;});}
  fetch('/api/payment-info',{credentials:'same-origin'}).then(function(r){return r.ok?r.json():null}).then(function(d){
    var p=d&&d.payment; if(!p){['bank','iban','cliq'].forEach(function(k){fill(k,'')});return;}
    fill('bank',p.bankName); fill('iban',p.iban); fill('cliq',p.cliqAlias);
    var extra=[]; if(p.swift) extra.push('SWIFT: '+p.swift); if(p.accountHolder) extra.push((ar?'المستفيد: ':'Beneficiary: ')+p.accountHolder); if(p.contactEmail) extra.push(p.contactEmail);
    all('extra').forEach(function(el){el.textContent=extra.length?' — '+extra.join(' — '):'';});
    /* إخفاء الخيار غير المضبوط بدل عرض كلمة "غير مضبوط" للمشتري */
    [].forEach.call(document.querySelectorAll('[data-pay-method="cliq"]'),function(el){el.hidden=!p.cliqAlias;});
    [].forEach.call(document.querySelectorAll('[data-pay-method="bank_transfer"]'),function(el){el.hidden=!p.iban;});
  }).catch(function(){['bank','iban','cliq'].forEach(function(k){fill(k,'')});});
})();
