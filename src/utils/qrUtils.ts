import QRCode from 'qrcode';

export interface StudentQrPayload {
  type: 'STUDENT_ATTENDANCE_QR';
  qrId: string;
  uid: string;
}

/**
 * Generates an opaque, collision-resistant permanent QR identifier linked to the student UID.
 * Does not contain facial descriptors, passwords, or personal PII.
 */
export const generatePermanentQrId = (uid: string): string => {
  const shortUid = uid.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8);
  const randomSuffix = Math.random().toString(36).substring(2, 10);
  const timeHex = Date.now().toString(36);
  return `stdqr_${shortUid}_${randomSuffix}_${timeHex}`;
};

/**
 * Builds the standard JSON string payload to encode into the student's permanent QR code.
 */
export const encodeStudentQrPayload = (qrId: string, uid: string): string => {
  const payload: StudentQrPayload = {
    type: 'STUDENT_ATTENDANCE_QR',
    qrId,
    uid,
  };
  return JSON.stringify(payload);
};

/**
 * Decodes scanned QR text. Supports both structured JSON payloads and raw qrId strings.
 */
export const decodeStudentQrPayload = (
  rawScannedText: string
): { qrId: string; uid?: string } | null => {
  if (!rawScannedText || typeof rawScannedText !== 'string') return null;

  const trimmed = rawScannedText.trim();

  // Try parsing JSON first
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object') {
      if (parsed.qrId && typeof parsed.qrId === 'string') {
        return {
          qrId: parsed.qrId.trim(),
          uid: typeof parsed.uid === 'string' ? parsed.uid.trim() : undefined,
        };
      }
    }
  } catch {
    // Not JSON, continue to check raw string
  }

  // If raw string has non-trivial length
  if (trimmed.length >= 6) {
    return {
      qrId: trimmed,
    };
  }

  return null;
};

/**
 * Renders a QR code data URL (PNG) with customized theme colors.
 */
export const generateQrDataUrl = async (
  text: string,
  options?: { width?: number; margin?: number; darkColor?: string; lightColor?: string }
): Promise<string> => {
  try {
    return await QRCode.toDataURL(text, {
      width: options?.width || 300,
      margin: options?.margin !== undefined ? options?.margin : 2,
      color: {
        dark: options?.darkColor || '#0f172a', // slate-900
        light: options?.lightColor || '#ffffff',
      },
      errorCorrectionLevel: 'M',
    });
  } catch (err) {
    console.warn('QRCode.toDataURL failed, using fallback server URL:', err);
    return `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(text)}&size=${options?.width || 300}x${options?.width || 300}&margin=${options?.margin || 2}`;
  }
};
