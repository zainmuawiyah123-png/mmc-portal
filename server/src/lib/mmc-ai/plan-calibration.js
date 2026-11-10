'use strict';

/**
 * Converts raw PDF path bounds into metric dimensions only when the user
 * explicitly confirms both corresponding real-world dimensions.
 * This does not infer scale from labels or a printed scale note.
 */
function calibratePlanMeasurements({ rawBounds, knownWidthMm, knownHeightMm, tolerance = 0.02 } = {}) {
  const fail = (reason) => ({ status: 'needs_manual_calibration', reason });
  if (!rawBounds || ![rawBounds.minX, rawBounds.minY, rawBounds.maxX, rawBounds.maxY].every(Number.isFinite)) {
    return fail('حدود الرسم غير مكتملة أو غير رقمية.');
  }
  const rawWidth = rawBounds.maxX - rawBounds.minX;
  const rawHeight = rawBounds.maxY - rawBounds.minY;
  if (!(rawWidth > 0) || !(rawHeight > 0)) return fail('أبعاد حدود الرسم يجب أن تكون أكبر من صفر.');
  if (!(Number.isFinite(knownWidthMm) && knownWidthMm > 0 && Number.isFinite(knownHeightMm) && knownHeightMm > 0)) {
    return fail('يلزم إدخال بُعدي العرض والارتفاع الحقيقيين المؤكدين من المستخدم بالملليمتر.');
  }
  if (!(Number.isFinite(tolerance) && tolerance >= 0 && tolerance <= 0.1)) {
    return fail('نسبة السماحية غير صالحة.');
  }

  const scaleX = knownWidthMm / rawWidth;
  const scaleY = knownHeightMm / rawHeight;
  const relativeDifference = Math.abs(scaleX - scaleY) / Math.max(scaleX, scaleY);
  if (relativeDifference > tolerance) {
    return {
      ...fail('الأبعاد المؤكدة لا تتوافق مع نسبة حدود الرسم؛ راجع حدود المخطط أو الأبعاد المدخلة.'),
      scaleXmmPerUnit: scaleX,
      scaleYmmPerUnit: scaleY,
      relativeScaleDifference: relativeDifference
    };
  }

  const scaleMmPerUnit = (scaleX + scaleY) / 2;
  const widthM = knownWidthMm / 1000;
  const heightM = knownHeightMm / 1000;
  return {
    status: 'calibrated_from_user_confirmed_dimensions',
    calibrationSource: 'user_confirmed_dimensions',
    rawBounds: { ...rawBounds },
    rawWidth,
    rawHeight,
    knownWidthMm,
    knownHeightMm,
    scaleMmPerUnit,
    scaleXmmPerUnit: scaleX,
    scaleYmmPerUnit: scaleY,
    relativeScaleDifference: relativeDifference,
    widthM,
    heightM,
    areaM2: widthM * heightM,
    limitations: [
      'المعايرة تعتمد على بُعدي العرض والارتفاع اللذين أدخلهما المستخدم وأكد مطابقتهما لحدود الرسم.',
      'لا يتم استنتاج المقياس تلقائياً من نص مثل Scale 1:100.',
      'النتيجة مساحة مستطيل حدود المخطط فقط، وليست مساحة صافية للغرف أو حصر كميات.'
    ]
  };
}

module.exports = { calibratePlanMeasurements };
