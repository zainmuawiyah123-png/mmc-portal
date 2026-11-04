'use strict';

/**
 * MMC Public Tender Intelligence taxonomy.
 * Stable machine keys are persisted; labels are bilingual and may evolve.
 * Countries enabled in the first release: JO, SA, AE.
 */
const COUNTRIES = [
  { code: 'JO', nameAr: 'الأردن', nameEn: 'Jordan', currency: 'JOD' },
  { code: 'SA', nameAr: 'السعودية', nameEn: 'Saudi Arabia', currency: 'SAR' },
  { code: 'AE', nameAr: 'الإمارات', nameEn: 'United Arab Emirates', currency: 'AED' }
];

const CATEGORIES = [
  { key: 'roads-bridges', nameAr: 'الطرق والجسور والأنفاق', nameEn: 'Roads, Bridges & Tunnels', tags: ['roads','highways','bridges','tunnels','طرق','جسور','أنفاق'] },
  { key: 'earthworks', nameAr: 'الحفريات والردم والأعمال الترابية', nameEn: 'Earthworks & Excavation', tags: ['earthworks','excavation','backfilling','grading','حفر','ردم','تسوية','أعمال ترابية'] },
  { key: 'dams-water', nameAr: 'السدود والمياه والمنشآت المائية', nameEn: 'Dams, Water & Hydraulic Works', tags: ['dams','reservoirs','water networks','hydraulic','سدود','خزانات','شبكات مياه'] },
  { key: 'buildings', nameAr: 'المباني والمنشآت', nameEn: 'Buildings & Structures', tags: ['buildings','schools','hospitals','industrial buildings','مباني','مدارس','مستشفيات','منشآت'] },
  { key: 'industrial-civil', nameAr: 'الأعمال المدنية الصناعية', nameEn: 'Industrial Civil Works', tags: ['industrial','plant','foundations','factories','صناعي','مصانع','قواعد'] },
  { key: 'water-wastewater', nameAr: 'المياه والصرف الصحي', nameEn: 'Water & Wastewater', tags: ['water','wastewater','sewer','treatment plant','مياه','صرف صحي','محطات معالجة'] },
  { key: 'concrete-steel', nameAr: 'الخرسانة والحديد والإنشاءات المعدنية', nameEn: 'Concrete, Steel & Metal Works', tags: ['concrete','reinforcement','steel','structural','خرسانة','حديد','إنشاءات معدنية'] },
  { key: 'geosynthetics-lining', nameAr: 'العزل والبطانات والجيوممبرين', nameEn: 'Waterproofing, Liners & Geosynthetics', tags: ['HDPE','geomembrane','geotextile','lining','waterproofing','جيوممبرين','جيوتكستايل','عزل','بطانات'] },
  { key: 'electrical-energy', nameAr: 'الكهرباء والطاقة والطاقة المتجددة', nameEn: 'Electrical, Energy & Renewables', tags: ['electrical','solar','power','renewable','كهرباء','طاقة','طاقة شمسية'] },
  { key: 'mechanical-hvac', nameAr: 'الأعمال الميكانيكية والتكييف', nameEn: 'Mechanical & HVAC', tags: ['mechanical','HVAC','pumps','firefighting','ميكانيك','تكييف','مضخات','إطفاء'] },
  { key: 'telecom-it', nameAr: 'الاتصالات وتقنية المعلومات', nameEn: 'Telecom & IT', tags: ['telecom','ICT','software','network','اتصالات','تقنية المعلومات','برمجيات','شبكات'] },
  { key: 'supplies-equipment', nameAr: 'التوريدات والمعدات والآليات', nameEn: 'Supplies, Equipment & Machinery', tags: ['supply','equipment','machinery','vehicles','توريد','معدات','آليات','مركبات'] },
  { key: 'consultancy-design', nameAr: 'الاستشارات والتصميم والإشراف', nameEn: 'Consultancy, Design & Supervision', tags: ['consultancy','design','supervision','engineering services','استشارات','تصميم','إشراف','خدمات هندسية'] },
  { key: 'operation-maintenance', nameAr: 'التشغيل والصيانة', nameEn: 'Operation & Maintenance', tags: ['operation','maintenance','O&M','تشغيل','صيانة'] },
  { key: 'other-services', nameAr: 'خدمات أخرى', nameEn: 'Other Services', tags: [] }
];

const STATUSES = [
  { key: 'open', nameAr: 'مفتوح', nameEn: 'Open' },
  { key: 'closing-soon', nameAr: 'قريب الإغلاق', nameEn: 'Closing Soon' },
  { key: 'closed', nameAr: 'مغلق', nameEn: 'Closed' },
  { key: 'cancelled', nameAr: 'ملغى', nameEn: 'Cancelled' },
  { key: 'awarded', nameAr: 'تمت الإحالة', nameEn: 'Awarded' },
  { key: 'unknown', nameAr: 'غير محدد', nameEn: 'Unverified Status' }
];

function normalizeText(value) {
  return String(value || '').toLocaleLowerCase().replace(/[إأآ]/g, 'ا').replace(/ى/g, 'ي').replace(/[^\\p{L}\\p{N}]+/gu, ' ').trim();
}

function suggestCategories(text) {
  const haystack = normalizeText(text);
  return CATEGORIES.map((category) => {
    const hits = category.tags.filter((tag) => haystack.includes(normalizeText(tag)));
    return { key: category.key, score: hits.length, matchedTags: hits };
  }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score);
}

module.exports = { COUNTRIES, CATEGORIES, STATUSES, normalizeText, suggestCategories };
