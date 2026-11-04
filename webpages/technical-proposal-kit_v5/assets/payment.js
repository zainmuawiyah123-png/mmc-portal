/* Public payment instructions are sourced only from live server configuration. */
(function(){
  [].forEach.call(document.querySelectorAll('[data-pay]'),function(el){el.textContent='';});
  fetch('/api/payment-info',{credentials:'same-origin',cache:'no-store'})
    .then(function(r){if(!r.ok)throw new Error('Payment details unavailable');return r.json();})
    .then(function(d){
      if(!d||!d.payment)return;
      var p=d.payment;
      function fill(k,v){if(!v)return;[].forEach.call(document.querySelectorAll('[data-pay="'+k+'"]'),function(el){el.textContent=String(v);});}
      fill('iban',p.iban);fill('cliq',p.cliqAlias);
      var extra=[];if(p.swift)extra.push('SWIFT: '+p.swift);if(p.accountHolder)extra.push('Beneficiary: '+p.accountHolder);if(p.contactEmail)extra.push(p.contactEmail);
      fill('extra',extra.join(' — '));
    })
    .catch(function(){
      [].forEach.call(document.querySelectorAll('[data-pay]'),function(el){el.textContent='Available during authenticated checkout';});
    });
})();
