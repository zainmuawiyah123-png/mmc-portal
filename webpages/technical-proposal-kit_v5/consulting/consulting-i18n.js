/* MMC Consulting Portal bilingual layer. Keeps business/API logic untouched. */
(function () {
 'use strict';
 var KEY='tpkit-portal-lang', busy=false;
 var map={
 'بوابة المكاتب الاستشارية':'Consulting Office Portal',
 'تسجيل الدخول':'Sign in','تسجيل مكتب استشاري':'Register consulting office','خروج':'Log out',
 'بوابة مستقلة لإدارة المكاتب الاستشارية':'Independent Consulting Office Portal',
 'لوحة إدارة المكتب الاستشاري':'Consulting Office Dashboard',
 'إدارة فرص الخدمات الاستشارية المنشورة عبر المنصة، عروض المكتب، العقود، ومتابعة التنفيذ. هذه البوابة مستقلة عن بوابة المقاولين وبوابة الجهة الطالبة.':'Manage consulting opportunities published on the platform, office proposals, contracts, and delivery tracking. This portal is separate from the contractor and procuring-entity portals.',
 'لوحة التحكم':'Dashboard','فرص الجهات':'Client opportunities','سوق عطاءات المكاتب':'Consultancy tender market',
 'عروضي للمكاتب':'My proposals to offices','عطاءاتي وطلباتي':'My tenders & requests',
 'عروضي للجهات':'My proposals to clients','عقودي مع الجهات':'My client contracts',
 'التعاقدات الفرعية':'Subcontracts','فريق المكتب':'Office team','التقارير':'Reports','ملف المكتب والاشتراك':'Office profile & subscription',
 'الفرص الاستشارية المتاحة':'Available consulting opportunities','العروض المقدمة':'Proposals submitted',
 'العقود المسندة':'Awarded contracts','الاشتراك الاحترافي':'Professional subscription',
 'جارٍ تحميل بيانات الحساب…':'Loading account data…','ملف المكتب الاستشاري':'Consulting office profile',
 'حالة التحقق:':'Verification status:','قيد المراجعة':'Under review','موثّق':'Verified','مرفوض':'Rejected','موقوف':'Suspended',
 'الباقة الاحترافية: 20 USD شهرياً. أول عطاء مجاني. بوابة الدفع والتفعيل الآلي لم يجرِ تشغيلهما بعد، ولن يتم احتساب رسوم قبل تفعيلهما رسمياً.':'Professional plan: USD 20/month. First tender is free. Payment and automatic activation are not live; no fees will be charged before official activation.',
 'الوثائق القانونية والمهنية للمكتب':'Office legal and professional documents',
 'ارفع شهادة التسجيل والرخص المهنية والضريبية والتأمين وسابقة الأعمال. تظهر هذه الوثائق لمدير الإدارة ضمن ملف المراجعة فقط.':'Upload the registration certificate, professional and tax licences, insurance, and portfolio. These documents are visible only to the administrator during review.',
 'تصنيف الوثيقة':'Document type','شهادة التسجيل':'Registration certificate','رخصة مهنية':'Professional licence',
 'شهادة ضريبية':'Tax certificate','التأمين المهني':'Professional indemnity insurance','سابقة الأعمال':'Portfolio',
 'تفويض/وكالة':'Authorisation','أخرى':'Other','الملفات':'Files','رفع الوثائق إلى ملف المراجعة':'Upload documents for review',
 'تسجيل مكتب استشاري':'Register consulting office','أدخل بيانات المكتب القانونية. يبقى الملف قيد المراجعة حتى التحقق منه.':'Enter the office legal details. The profile remains under review until verified.',
 'الاسم القانوني للمكتب':'Office legal name','الدولة':'Country','الأردن':'Jordan','السعودية':'Saudi Arabia','الإمارات':'United Arab Emirates',
 'رقم التسجيل القانوني':'Legal registration number','البريد الرسمي':'Business email','الهاتف الرسمي':'Business phone',
 'الموقع الإلكتروني':'Website','التخصصات (افصل بينها بفاصلة)':'Specialisations (comma-separated)',
 'تصميم إنشائي، إشراف، طرق، بنية تحتية':'Structural design, supervision, roads, infrastructure',
 'الخبرات والمشاريع السابقة':'Experience and previous projects','إرسال ملف المكتب للتحقق':'Submit office profile for verification',
 'العطاءات والفرص الاستشارية المنشورة':'Published consulting tenders and opportunities',
 'تظهر هنا طلبات الخدمات الاستشارية المنشورة من الجهات المختلفة على المنصة. يمكن للمكتب تقديم عرض فني ومالي مستقل؛ ولا تظهر له عروض المكاتب المنافسة.':'Consulting service requests published by different entities appear here. Offices can submit separate technical and financial proposals; competing offices’ proposals remain private.',
 'سوق العطاءات الاستشارية المنشورة من المكاتب':'Consulting tenders published by offices',
 'فرص فرعية تنشرها مكاتب استشارية أخرى لطلب تخصصات استشارية مساندة. لا تظهر هنا عطاءات المقاولات أو التوريد.':'Subcontract opportunities published by other consulting offices for supporting specialisations. Construction and supply tenders are not shown here.',
 'عروضي المقدمة إلى المكاتب الاستشارية':'My proposals to consulting offices',
 'عطاءاتي الاستشارية وإدارة العروض':'My consulting tenders and proposal management',
 'يمكن للمكتب نشر طلبات استشارية فرعية، واستقبال عروض المكاتب الأخرى، وتقييمها فنياً ثم فتح المالي للمؤهلين فقط.':'The office can publish consulting sub-tenders, receive proposals from other offices, evaluate them technically, and open financial proposals only for qualified bidders.',
 'عنوان العطاء':'Tender title','التخصص':'Discipline','التصميم الهندسي':'Engineering design','الإشراف الموقعي':'Site supervision',
 'إدارة المشاريع':'Project management','حصر الكميات':'Quantity surveying','الجيوتقنية':'Geotechnical',
 'البيئة':'Environmental','النقل والطرق':'Transportation and roads','المياه والصرف الصحي':'Water and wastewater',
 'العمارة':'Architecture','خدمات استشارية أخرى':'Other consulting services','الموقع':'Location','العملة':'Currency',
 'الميزانية الدنيا':'Minimum budget','الميزانية العليا':'Maximum budget','تاريخ الإغلاق':'Closing date',
 'الحد الفني من 100':'Technical threshold out of 100','وصف نطاق الخدمة':'Service scope description',
 'المهام والمخرجات (كل مهمة في سطر)':'Tasks and deliverables (one per line)',
 'مراجعة التصاميم\nإعداد التقارير\nالإشراف':'Design review\nReporting\nSupervision',
 'نشر العطاء الاستشاري الفرعي':'Publish consulting sub-tender','التعاقدات الاستشارية الفرعية':'Consulting subcontracts',
 'فريق المكتب وصلاحياته':'Office team and permissions',
 'أضف أعضاء لديهم حسابات استشارية مسجلة، وحدد مديراً أو موظفاً. يظل مالك المكتب وحده مخولاً بإدارة العضويات واعتماد قرارات التحقق.':'Add members with registered consulting accounts and assign manager or staff roles. Only the office owner can manage memberships and approve verification decisions.',
 'البريد الإلكتروني للعضو':'Member email','الدور':'Role','مدير':'Manager','موظف':'Staff','إضافة عضو':'Add member',
 'تقارير أداء المكتب':'Office performance reports',
 'ملخص تشغيلي لحساب المكتب الحالي فقط، دون كشف بيانات أو عروض المكاتب المنافسة.':'Operational summary for this office only; competing offices’ data and proposals are never disclosed.',
 'عروضي الفنية والمالية':'My technical and financial proposals',
 'متابعة العروض التي قدمها هذا المكتب فقط، مع إتاحة الوثائق الخاصة به.':'Track proposals submitted by this office only, with access to its own documents.',
 'العقود ومتابعة التنفيذ':'Contracts and delivery tracking','معلومات الباقة':'Plan information',
 'الأساسية: مجانية لملف المكتب.':'Basic: free office profile.',
 'الاحترافية: 20 USD شهرياً، ويظل تفعيلها مغلقاً حتى استكمال الفوترة المستقلة.':'Professional: USD 20/month; activation remains disabled until separate billing is complete.',
 'التقديم على طلبات السوق متاح للمكاتب التي اكتمل التحقق القانوني منها.':'Submitting to market requests is available to offices that have completed legal verification.',
 'لا توجد وثائق مرفقة.':'No documents attached.','رفع الوثائق':'Upload documents','الملخص الفني والخبرات ذات الصلة':'Technical summary and relevant experience',
 'منهجية التنفيذ':'Delivery methodology','الفريق المقترح':'Proposed team','مدة التنفيذ بالأيام':'Delivery duration in days',
 'إرسال العرض':'Submit proposal','لا توجد طلبات مفتوحة حالياً.':'No open requests currently.',
 'لا توجد عقود مسندة للمكتب بعد.':'No contracts have been awarded to this office yet.',
 'الجهة:':'Client:','الحالة:':'Status:','النطاق:':'Scope:','الميزانية:':'Budget:','آخر موعد:':'Deadline:',
 'تسجيل الدخول لتقديم عرض':'Sign in to submit a proposal','تسجيل الدخول / إنشاء حساب':'Sign in / Create account',
 'وضع المشاهدة العامة':'Public browsing mode',
 'يمكنك تصفح الفرص المنشورة وأقسام بوابة المكاتب الاستشارية. تتطلب إدارة المكتب وتقديم العروض والوثائق والعقود تسجيل الدخول ببريد العمل.':'You can browse published opportunities and consulting portal sections. Office management, proposals, documents, and contracts require signing in with your business email.',
 'يتطلب عرض بيانات المكتب وإدارة العروض والوثائق والعقود تسجيل الدخول ببريد العمل.':'Viewing office data and managing proposals, documents, and contracts requires signing in with your business email.',
 'لا توجد طلبات استشارية منشورة حالياً.':'No consulting requests are currently published.',
 'لا توجد عطاءات فرعية منشورة حالياً.':'No sub-tenders are currently published.',
 'تعذر تحميل الفرص':'Could not load opportunities','تعذر الاتصال بالخادم':'Could not connect to the server',
 'تم رفع الوثائق بنجاح.':'Documents uploaded successfully.','تم تسجيل التحديث.':'Update recorded.',
 'تحديث التقدم أو الإنجاز':'Progress or completion update','نسبة الإنجاز %':'Completion percentage %',
 'إضافة تحديث':'Add update','سجل التحديثات':'Update history','لا توجد تحديثات.':'No updates.',
 'وثائق التعاقد':'Contract documents','لا توجد وثائق.':'No documents.',
 'تأكيد بدء التنفيذ':'Confirm start of delivery','اعتماد اكتمال التعاقد':'Approve contract completion',
 'تم التحقق من المكتب. وظائف السوق والعروض والعقود متاحة، وإدارة العطاءات والفريق والتقارير لمالك المكتب ومديره.':'Office verified. Market, proposals, and contracts are available; tender, team, and report management is available to the owner and manager.',
 'عضوية المكتب موقوفة حالياً. راجع مسؤول المنصة.':'Office membership is currently suspended. Contact the platform administrator.',
 'ملف المكتب قيد المراجعة. ستفتح وظائف السوق بعد اعتماد التحقق القانوني.':'The office profile is under review. Market functions will open after legal verification.',
 'لا يوجد ملف مكتب مرتبط بهذا الحساب. يمكنك تسجيل مكتبك الآن.':'No office profile is linked to this account. You can register your office now.',
 'رقم التسجيل:':'Registration no:','نطاق العمل:':'Scope of work:'
 };
 function lang(){try{return localStorage.getItem(KEY)||'ar'}catch(e){return 'ar'}}
 function translate(s,l){if(l==='ar')return s;var t=map[s];return t||s}
 function walk(root,l){var w=document.createTreeWalker(root,NodeFilter.SHOW_TEXT),n,arr=[];while(n=w.nextNode())arr.push(n);arr.forEach(function(x){var raw=x.nodeValue,trim=raw.trim();if(!trim)return;var out=translate(trim,l);if(out!==trim){var a=raw.indexOf(trim);x.nodeValue=raw.slice(0,a)+out+raw.slice(a+trim.length)}})}
 function apply(){if(busy)return;busy=true;var l=lang();document.documentElement.lang=l;document.documentElement.dir=l==='ar'?'rtl':'ltr';document.title=l==='en'?'Consulting Office Portal | MMC':'بوابة المكاتب الاستشارية | MMC';walk(document.body,l);
 document.querySelectorAll('input,textarea').forEach(function(e){var p=e.getAttribute('data-i18n-original-placeholder');if(p===null){p=e.placeholder;e.setAttribute('data-i18n-original-placeholder',p)}if(p)e.placeholder=translate(p,l)});
 document.querySelectorAll('option').forEach(function(e){var p=e.getAttribute('data-i18n-original-label');if(p===null){p=e.textContent;e.setAttribute('data-i18n-original-label',p)}e.textContent=translate(p,l)});
 document.querySelectorAll('[data-lang-btn]').forEach(function(b){b.classList.toggle('on',b.dataset.langBtn===l)});
 busy=false;
 }
 function set(l){if(l!=='ar'&&l!=='en')return;try{localStorage.setItem(KEY,l)}catch(e){}apply()}
 var header=document.querySelector('.p-top');if(header&&window.MMC_I18N)MMC_I18N.mountSwitcher(header);else if(header){var sw=document.createElement('div');sw.className='lang-switch';sw.innerHTML='<button type="button" data-lang-btn="ar">AR</button><button type="button" data-lang-btn="en">EN</button>';header.append(sw);sw.querySelectorAll('button').forEach(function(b){b.addEventListener('click',function(){set(b.dataset.langBtn)})})}
 document.addEventListener('click',function(e){var b=e.target.closest('[data-lang-btn]');if(b)set(b.dataset.langBtn)});
 apply();new MutationObserver(function(){if(!busy)apply()}).observe(document.body,{subtree:true,childList:true,characterData:true});
 window.addEventListener('mmc:lang',apply);
 window.MMC_CONSULTING_I18N={setLang:set,apply:apply};
})();