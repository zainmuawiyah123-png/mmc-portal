'use strict';

// Central catalogue: discovery targets, not a claim that every connector is live.
// connectorStatus remains "planned" until a source-specific importer is implemented and tested.
const SOURCES = [
  { key:'joneps-jordan', nameAr:'نظام الشراء الإلكتروني الأردني JONEPS', nameEn:'Jordan Online E-Procurement System', countryCode:'JO', marketScope:'national', publisherType:'government', url:'https://www.joneps.gov.jo/ep/invt/selectListEOIAL.do', connectorStatus:'planned', accessMode:'public-listing-must-be-validated' },
  { key:'arab-potash-company', nameAr:'شركة البوتاس العربية', nameEn:'Arab Potash Company (APC)', countryCode:'JO', marketScope:'private-sector', publisherType:'private-company', url:'https://www.arabpotash.com/EN/Modules/Tenders', connectorStatus:'prototype', accessMode:'public-listing' },
  { key:'saudi-etimad', nameAr:'منصة اعتماد السعودية', nameEn:'Saudi Etimad Procurement Platform', countryCode:'SA', marketScope:'national', publisherType:'government', url:'https://etimad.sa/', connectorStatus:'planned', accessMode:'portal-access-terms-review-required' },
  { key:'uae-ministry-finance', nameAr:'وزارة المالية الإماراتية — المشتريات الحكومية', nameEn:'UAE Ministry of Finance — Federal Procurement', countryCode:'AE', marketScope:'national', publisherType:'government', url:'https://mof.gov.ae/', connectorStatus:'planned', accessMode:'public-source-validation-required' },
  { key:'ungm', nameAr:'بوابة الأمم المتحدة للمشتريات UNGM', nameEn:'United Nations Global Marketplace', countryCode:null, marketScope:'international', publisherType:'un-agency', organizationFamily:'un-system', url:'https://www.ungm.org/Public/Notice', connectorStatus:'planned', accessMode:'public-notices' },
  { key:'un-procurement', nameAr:'إدارة المشتريات — الأمم المتحدة', nameEn:'UN Procurement Division', countryCode:null, marketScope:'international', publisherType:'un-agency', organizationFamily:'un-system', url:'https://www.un.org/procurement/', connectorStatus:'planned', accessMode:'public-notices' },
  { key:'world-bank-procurement', nameAr:'البنك الدولي — فرص المشتريات', nameEn:'World Bank Procurement', countryCode:null, marketScope:'development-financed', publisherType:'multilateral-bank', organizationFamily:'development-banks', url:'https://projects.worldbank.org/en/projects-operations/procurement', connectorStatus:'planned', accessMode:'public-project-data-validation-required' },
  { key:'ebrd-procurement', nameAr:'البنك الأوروبي لإعادة الإعمار — العطاءات', nameEn:'EBRD Procurement Notices', countryCode:null, marketScope:'development-financed', publisherType:'multilateral-bank', organizationFamily:'development-banks', url:'https://www.ebrd.com/home/work-with-us/project-procurement/procurement-notices.html', connectorStatus:'planned', accessMode:'public-notices-and-ecepp-registration' },
  { key:'tenderjo', nameAr:'تندر جو — مصدر تجاري إقليمي', nameEn:'TenderJO / TenderGlobal', countryCode:null, marketScope:'international', publisherType:'private-company', url:'https://www.tender.jo/', connectorStatus:'review-required', accessMode:'commercial-licence-required-before-ingestion' }
];

module.exports = { SOURCES };
