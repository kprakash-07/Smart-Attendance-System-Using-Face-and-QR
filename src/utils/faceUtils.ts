import * as faceapi from 'face-api.js';

let modelsLoaded = false;
let modelLoadingPromise: Promise<void> | null = null;
let modelLoadingError: string | null = null;
let modelStatus: 'NOT_LOADED' | 'LOADING' | 'LOADED' | 'ERROR' = 'NOT_LOADED';

/**
 * Loads the face-api.js neural network models from /models once.
 */
export async function loadFaceApiModels(modelsUri: string = '/models'): Promise<void> {
  if (isFaceApiLoaded()) {
    modelStatus = 'LOADED';
    modelsLoaded = true;
    return;
  }
  if (modelLoadingPromise) return modelLoadingPromise;

  modelStatus = 'LOADING';
  modelLoadingError = null;

  modelLoadingPromise = (async () => {
    try {
      console.log('[face-api.js] Loading neural network models from:', modelsUri);
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(modelsUri),
        faceapi.nets.faceLandmark68Net.loadFromUri(modelsUri),
        faceapi.nets.faceRecognitionNet.loadFromUri(modelsUri),
      ]);

      modelsLoaded = true;
      modelStatus = 'LOADED';
      modelLoadingError = null;
      console.log('[face-api.js] All models loaded successfully.');

      // Warm up shaders so first webcam frame doesn't freeze on initial shader compilation
      try {
        await warmUpFaceApi();
      } catch (warmErr) {
        console.warn('[face-api.js] Warm-up notice (non-fatal):', warmErr);
      }
    } catch (err: any) {
      modelsLoaded = false;
      modelStatus = 'ERROR';
      modelLoadingError = err?.message || String(err);
      console.warn('face-api.js - Model load notice:', err);
      modelLoadingPromise = null;
      throw err;
    }
  })();

  return modelLoadingPromise;
}

let isWarmedUp = false;

/**
 * Pre-warms the face detection and recognition neural networks using a small dummy canvas.
 * This forces TensorFlow.js to compile all WebGL shaders ahead of time, preventing
 * frame latency spikes and detector timeouts on the first live camera frame.
 */
export async function warmUpFaceApi(): Promise<void> {
  if (isWarmedUp || !isFaceApiLoaded()) return;
  if (typeof document === 'undefined') return;

  try {
    const dummy = document.createElement('canvas');
    dummy.width = 160;
    dummy.height = 160;
    const ctx = dummy.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#808080';
      ctx.fillRect(0, 0, 160, 160);
    }

    const warmOpts = initTinyFaceDetector(160, 0.5);
    // Warm up TinyFaceDetector shaders
    try {
      await faceapi.detectSingleFace(dummy, warmOpts);
    } catch {
      // Ignore detection outcome on dummy canvas
    }

    // Warm up FaceLandmark68Net and FaceRecognitionNet shaders
    if (faceapi.nets.faceLandmark68Net.isLoaded && faceapi.nets.faceRecognitionNet.isLoaded) {
      try {
        await faceapi.detectSingleFace(dummy, warmOpts).withFaceLandmarks().withFaceDescriptor();
      } catch {
        // Ignore detection outcome on dummy canvas
      }
    }
    isWarmedUp = true;
    console.log('[face-api.js] Neural network shaders warmed up and ready.');
  } catch (err) {
    console.warn('[face-api.js] Warm-up encountered non-fatal notice:', err);
  }
}

export function isFaceApiLoaded(): boolean {
  return Boolean(
    faceapi.nets.tinyFaceDetector.isLoaded &&
    faceapi.nets.faceLandmark68Net.isLoaded &&
    faceapi.nets.faceRecognitionNet.isLoaded
  );
}

export function getModelStatus(): 'NOT_LOADED' | 'LOADING' | 'LOADED' | 'ERROR' {
  if (isFaceApiLoaded()) return 'LOADED';
  return modelStatus;
}

export function getModelLoadingError(): string | null {
  return modelLoadingError;
}

/**
 * Helper to calculate Euclidean distance between two 2D points.
 */
function ptDist(p1: { x: number; y: number }, p2: { x: number; y: number }): number {
  return Math.hypot(p1.x - p2.x, p1.y - p2.y);
}

/**
 * Calculates Eye Aspect Ratio (EAR) from 68 facial landmarks.
 * Right eye: landmarks 36 to 41
 * Left eye: landmarks 42 to 47
 * EAR = (||p2 - p6|| + ||p3 - p5||) / (2 * ||p1 - p4||)
 */
export function calculateEAR(pts: Array<{ x: number; y: number }>): {
  leftEAR: number;
  rightEAR: number;
  avgEAR: number;
} {
  if (!pts || pts.length < 68) {
    return { leftEAR: 0.3, rightEAR: 0.3, avgEAR: 0.3 };
  }

  // Right eye landmarks (36..41 in sensor space)
  const p36 = pts[36], p37 = pts[37], p38 = pts[38], p39 = pts[39], p40 = pts[40], p41 = pts[41];
  const rightWidth = ptDist(p36, p39);
  const rightEAR = rightWidth > 0 ? (ptDist(p37, p41) + ptDist(p38, p40)) / (2 * rightWidth) : 0.3;

  // Left eye landmarks (42..47 in sensor space)
  const p42 = pts[42], p43 = pts[43], p44 = pts[44], p45 = pts[45], p46 = pts[46], p47 = pts[47];
  const leftWidth = ptDist(p42, p45);
  const leftEAR = leftWidth > 0 ? (ptDist(p43, p47) + ptDist(p44, p46)) / (2 * leftWidth) : 0.3;

  const avgEAR = (leftEAR + rightEAR) / 2;
  return { leftEAR, rightEAR, avgEAR };
}

export const POSE_THRESHOLDS = {
  // Absolute normalized yaw below or equal to this is classified as STRAIGHT.
  // Configurable threshold: 0.13 allows natural variation (~±13% of facial width, ~20-25px)
  // on normal laptop webcams without feeling rigid or getting stuck.
  STRAIGHT_TOLERANCE: 0.13,

  // Minimum normalized yaw to qualify as a deliberate head turn to the user's LEFT
  LEFT_MIN: 0.15,

  // Maximum normalized yaw (negative) to qualify as a deliberate head turn to the user's RIGHT
  RIGHT_MIN: -0.15,

  // Backward compatibility aliases
  STRAIGHT_THRESHOLD: 0.13,
  LEFT_THRESHOLD: 0.15,
  RIGHT_THRESHOLD: -0.15,
  STRAIGHT_MAX: 0.13,
};

export type PoseType = 'STRAIGHT' | 'LEFT' | 'RIGHT' | 'UNKNOWN';

export interface HeadPose {
  physicalYaw: number | null; // Positive = physically turned LEFT, Negative = physically turned RIGHT, 0 = STRAIGHT
  pose: PoseType;            // 'STRAIGHT' | 'LEFT' | 'RIGHT' | 'UNKNOWN'
  isStraight: boolean;
  isPhysicalTurnLeft: boolean;
  isPhysicalTurnRight: boolean;
  normalizedNoseOffset: number;
  faceWidth?: number;
  noseX?: number;
  faceCenterX?: number;
}

export interface HeadPoseDetectionResult {
  pose: PoseType;
  yaw: number;
  rawOffset: number;
  faceWidth: number;
  noseX: number;
  faceCenterX: number;
  isStraight: boolean;
  isPhysicalTurnLeft: boolean;
  isPhysicalTurnRight: boolean;
}

/**
 * Safely extracts numeric coordinate from a landmark point,
 * supporting face-api.js getters (.x/.y) and internal props (._x/._y).
 */
function getPtCoord(pt: any): { x: number; y: number } {
  if (!pt) return { x: 0, y: 0 };
  const x =
    typeof pt.x === 'number' && Number.isFinite(pt.x)
      ? pt.x
      : typeof pt._x === 'number' && Number.isFinite(pt._x)
      ? pt._x
      : 0;
  const y =
    typeof pt.y === 'number' && Number.isFinite(pt.y)
      ? pt.y
      : typeof pt._y === 'number' && Number.isFinite(pt._y)
      ? pt._y
      : 0;
  return { x, y };
}

/**
 * Accurately estimates head yaw and pose classification from 68 facial landmarks:
 * - Nose: landmark 30 (tip) + points 31-35 (base)
 * - Left eye region: points 36-41 (sensor left / user right)
 * - Right eye region: points 42-47 (sensor right / user left)
 * - Jaw: points 0 and 16 (jaw endpoints)
 * 
 * Formula:
 * 1. eyeMidpointX = (leftEyeCenterX + rightEyeCenterX) / 2
 * 2. jawCenterX = (jawLeftX + jawRightX) / 2
 * 3. faceCenterX = (eyeMidpointX + jawCenterX) / 2
 * 4. normalizedYaw = (noseX - faceCenterX) / faceWidth
 * 
 * Mirroring & Calibration:
 * In a user-facing webcam (mirrored preview):
 * - User physically turns LEFT -> nose shifts to image right in raw camera sensor -> normalizedYaw > 0
 * - User physically turns RIGHT -> nose shifts to image left in raw camera sensor -> normalizedYaw < 0
 * - Calibrated yaw = rawOffset - neutralYawBaseline
 * - User looks STRAIGHT -> |calibratedYaw| <= STRAIGHT_THRESHOLD
 */
export function detectHeadPose(
  landmarks: Array<{ x: number; y: number }> | { positions?: Array<any>; _positions?: Array<any> } | any,
  neutralYawBaseline: number = 0
): HeadPoseDetectionResult {
  let pts: any[] = [];
  if (Array.isArray(landmarks)) {
    pts = landmarks;
  } else if (landmarks && Array.isArray(landmarks.positions)) {
    pts = landmarks.positions;
  } else if (landmarks && Array.isArray(landmarks._positions)) {
    pts = landmarks._positions;
  } else if (landmarks && typeof landmarks.getPositions === 'function') {
    pts = landmarks.getPositions();
  }

  if (!pts || pts.length < 68) {
    return {
      pose: 'UNKNOWN',
      yaw: 0,
      rawOffset: 0,
      faceWidth: 0,
      noseX: 0,
      faceCenterX: 0,
      isStraight: false,
      isPhysicalTurnLeft: false,
      isPhysicalTurnRight: false,
    };
  }

  // 1. Nose position: landmark 30 is the prominent nose tip; 31..35 is the nose base
  const noseTip = getPtCoord(pts[30]);
  let sumNoseBaseX = 0;
  for (let i = 31; i <= 35; i++) {
    sumNoseBaseX += getPtCoord(pts[i]).x;
  }
  const noseBaseX = sumNoseBaseX / 5;
  const noseX = 0.80 * noseTip.x + 0.20 * noseBaseX;

  // 2. Eye centers:
  // Sensor Left Eye (user's right eye): pts[36..41]
  let sumLeftEyeX = 0;
  for (let i = 36; i <= 41; i++) {
    sumLeftEyeX += getPtCoord(pts[i]).x;
  }
  const eyeLeftCenterX = sumLeftEyeX / 6;

  // Sensor Right Eye (user's left eye): pts[42..47]
  let sumRightEyeX = 0;
  for (let i = 42; i <= 47; i++) {
    sumRightEyeX += getPtCoord(pts[i]).x;
  }
  const eyeRightCenterX = sumRightEyeX / 6;

  // Eye midpoint reference
  const eyeMidpointX = (eyeLeftCenterX + eyeRightCenterX) / 2;

  // 3. Jaw landmarks: pts[0] is user's right jaw (sensor left), pts[16] is user's left jaw (sensor right)
  const jawLeftX = getPtCoord(pts[0]).x;
  const jawRightX = getPtCoord(pts[16]).x;
  const jawCenterX = (jawLeftX + jawRightX) / 2;

  // Stable horizontal facial reference: midpoint between eye regions and jaw center
  const faceCenterX = (eyeMidpointX + jawCenterX) / 2;

  // Face width across jawline (or 2x inter-ocular distance if jaw is clipped)
  const jawWidth = Math.abs(jawRightX - jawLeftX);
  const interEyeDist = Math.abs(eyeRightCenterX - eyeLeftCenterX);
  const faceWidth = Math.max(jawWidth > 20 ? jawWidth : interEyeDist * 2, 20);

  // Normalized horizontal nose displacement from face center
  const rawOffset = (noseX - faceCenterX) / faceWidth;
  
  // Calibrated relative yaw from user's neutral reference baseline
  const calibratedOffset = rawOffset - (Number.isFinite(neutralYawBaseline) ? neutralYawBaseline : 0);
  const yaw = Number(calibratedOffset.toFixed(3));

  // Single centralized pose classification:
  const classification = classifyHeadPose(yaw);

  return {
    pose: classification.pose,
    yaw,
    rawOffset: Number(rawOffset.toFixed(3)),
    faceWidth: Math.round(faceWidth),
    noseX: Math.round(noseX),
    faceCenterX: Math.round(faceCenterX),
    isStraight: classification.isStraight,
    isPhysicalTurnLeft: classification.isPhysicalTurnLeft,
    isPhysicalTurnRight: classification.isPhysicalTurnRight,
  };
}

/**
 * Classifies head pose into STRAIGHT, LEFT, RIGHT, or UNKNOWN based on physicalYaw.
 * Single centralized classification function ensuring consistent, forgiving thresholds.
 */
export function classifyHeadPose(physicalYaw: number | null): {
  pose: PoseType;
  isStraight: boolean;
  isPhysicalTurnLeft: boolean;
  isPhysicalTurnRight: boolean;
} {
  if (physicalYaw === null || isNaN(physicalYaw)) {
    return {
      pose: 'UNKNOWN',
      isStraight: false,
      isPhysicalTurnLeft: false,
      isPhysicalTurnRight: false,
    };
  }

  // Physical turn to the user's LEFT (positive yaw in mirrored webcam view)
  if (physicalYaw >= POSE_THRESHOLDS.LEFT_MIN) {
    return {
      pose: 'LEFT',
      isStraight: false,
      isPhysicalTurnLeft: true,
      isPhysicalTurnRight: false,
    };
  }

  // Physical turn to the user's RIGHT (negative yaw in mirrored webcam view)
  if (physicalYaw <= POSE_THRESHOLDS.RIGHT_MIN) {
    return {
      pose: 'RIGHT',
      isStraight: false,
      isPhysicalTurnLeft: false,
      isPhysicalTurnRight: true,
    };
  }

  // Between RIGHT_MIN and LEFT_MIN: user is looking STRAIGHT
  return {
    pose: 'STRAIGHT',
    isStraight: true,
    isPhysicalTurnLeft: false,
    isPhysicalTurnRight: false,
  };
}

/**
 * Accurately estimates horizontal head turn (Physical Left vs Physical Right)
 * using 68 facial landmarks via detectHeadPose with optional neutral baseline calibration.
 */
export function calculateHeadPose(
  pts: any,
  neutralYawBaseline: number = 0
): HeadPose {
  const result = detectHeadPose(pts, neutralYawBaseline);
  return {
    physicalYaw: result.yaw,
    pose: result.pose,
    isStraight: result.isStraight,
    isPhysicalTurnLeft: result.isPhysicalTurnLeft,
    isPhysicalTurnRight: result.isPhysicalTurnRight,
    normalizedNoseOffset: result.rawOffset,
    faceWidth: result.faceWidth,
    noseX: result.noseX,
    faceCenterX: result.faceCenterX,
  };
}

export interface FaceValidationResult {
  isValid: boolean;
  reason?: string;
  faceCount: number;
  hasLandmarks: boolean;
}

/**
 * Validates a detected face prior to checking pose:
 * - exactly one dominant face detected
 * - landmarks available (68 points)
 * - valid bounding box
 * - reasonable dimensions
 * 
 * Forgiving: Does not reject slightly off-center faces or arbitrary decorative frame margins.
 */
export function validateFace(
  detectionResult: any,
  allDetectionsCount: number,
  videoWidth: number,
  videoHeight: number
): FaceValidationResult {
  if (allDetectionsCount === 0 || !detectionResult) {
    return { isValid: false, reason: 'NO_FACE', faceCount: 0, hasLandmarks: false };
  }
  if (allDetectionsCount > 1) {
    return { isValid: false, reason: 'MULTIPLE_FACES', faceCount: allDetectionsCount, hasLandmarks: false };
  }

  const box = detectionResult.detection?.box || detectionResult.box;
  if (!box || !Number.isFinite(box.x) || !Number.isFinite(box.y) || box.width <= 0 || box.height <= 0) {
    return { isValid: false, reason: 'INVALID_BOX', faceCount: 1, hasLandmarks: false };
  }

  // Face reasonably sized: minimum width 20px, maximum 100% of frame
  const minWidth = Math.max(20, videoWidth * 0.04);
  const maxWidth = videoWidth * 0.99;
  if (box.width < minWidth || box.width > maxWidth) {
    return { isValid: false, reason: 'FACE_TOO_SMALL_OR_LARGE', faceCount: 1, hasLandmarks: false };
  }

  const landmarks = detectionResult.landmarks;
  const positions = landmarks?.positions || landmarks?._positions || landmarks;
  if (!positions || positions.length < 68) {
    return { isValid: false, reason: 'INSUFFICIENT_LANDMARKS', faceCount: 1, hasLandmarks: false };
  }

  return { isValid: true, faceCount: 1, hasLandmarks: true };
}

export interface LiveBiometricsResult {
  detection: faceapi.FaceDetection;
  landmarks: faceapi.FaceLandmarks68;
  hasLandmarks: boolean;
  descriptor?: number[];
  ear: { leftEAR: number; rightEAR: number; avgEAR: number };
  pose: HeadPose;
  box: { x: number; y: number; width: number; height: number };
  center: { x: number; y: number; normX: number; normY: number };
  isCentered: boolean;
  faceCount: number;
  qualityScore?: number;
  validation: FaceValidationResult;
}

export interface DetectOptions {
  extractDescriptor?: boolean; // Defaults to false if omitted
  inputSize?: number;          // Defaults to 416 (divisible by 32)
  scoreThreshold?: number;     // Defaults to 0.15
  neutralYawBaseline?: number; // Defaults to 0
  onDetectorError?: (error: string) => void;
  onDetectorSuccess?: () => void;
}

let lastLoggedDetectorError: string | null = null;
export function getLastDetectorError(): string | null {
  return lastLoggedDetectorError;
}

// Single initialized TinyFaceDetector options instance to avoid recreating every frame/render
let tinyFaceDetectorOptionsInstance: faceapi.TinyFaceDetectorOptions | null = null;
let configuredInputSize = 320;
let configuredScoreThreshold = 0.15;
let isDetectionInFlight = false;

export function initTinyFaceDetector(
  inputSize = 320,
  scoreThreshold = 0.15
): faceapi.TinyFaceDetectorOptions {
  if (
    !tinyFaceDetectorOptionsInstance ||
    configuredInputSize !== inputSize ||
    configuredScoreThreshold !== scoreThreshold
  ) {
    configuredInputSize = inputSize;
    configuredScoreThreshold = scoreThreshold;
    tinyFaceDetectorOptionsInstance = new faceapi.TinyFaceDetectorOptions({
      inputSize: configuredInputSize,
      scoreThreshold: configuredScoreThreshold,
    });
  }
  return tinyFaceDetectorOptionsInstance;
}

/**
 * Detects a single face in a video/canvas/image element and extracts
 * 68 facial landmarks, head pose (yaw), EAR, validation, and optionally the 128D biometric descriptor.
 * Uses a single TinyFaceDetector instance calibrated for standard webcams.
 */
export async function detectFaceBiometrics(
  input: HTMLVideoElement | HTMLCanvasElement | HTMLImageElement,
  detectOpts?: DetectOptions
): Promise<LiveBiometricsResult | null> {
  if (!input) return null;

  // 1. Strict video validation before calling face detection:
  // Must have srcObject, readyState >= 2, positive dimensions, and not be paused.
  if (typeof HTMLVideoElement !== 'undefined' && input instanceof HTMLVideoElement) {
    if (
      input.readyState < 2 ||
      !input.srcObject ||
      input.paused ||
      !input.videoWidth ||
      !input.videoHeight ||
      input.videoWidth <= 0 ||
      input.videoHeight <= 0
    ) {
      // Video is not ready yet; wait for valid frames
      return null;
    }
  } else if (typeof HTMLCanvasElement !== 'undefined' && input instanceof HTMLCanvasElement) {
    if (!input.width || !input.height || input.width <= 0 || input.height <= 0) {
      return null;
    }
  } else if (typeof HTMLImageElement !== 'undefined' && input instanceof HTMLImageElement) {
    if (!input.complete || !input.naturalWidth || !input.naturalHeight || input.naturalWidth <= 0 || input.naturalHeight <= 0) {
      return null;
    }
  }

  // 2. Ensure models are already loaded before detection (do not initialize inside frame loop)
  if (!faceapi.nets.tinyFaceDetector.isLoaded || !faceapi.nets.faceLandmark68Net.isLoaded) {
    return null;
  }

  const inputSize = detectOpts?.inputSize || 320;
  const scoreThreshold = detectOpts?.scoreThreshold || 0.15;
  const shouldExtractDescriptor = detectOpts?.extractDescriptor === true;
  const neutralYawBaseline = detectOpts?.neutralYawBaseline || 0;

  // Concurrency guard: avoid WebGL pipeline thrashing and queue pileups
  if (isDetectionInFlight) {
    if (!shouldExtractDescriptor) {
      return null;
    }
    const startWait = Date.now();
    while (isDetectionInFlight && Date.now() - startWait < 1500) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (isDetectionInFlight) {
      return null;
    }
  }

  isDetectionInFlight = true;

  // Pre-initialized TinyFaceDetectorOptions
  const tinyOpts = initTinyFaceDetector(inputSize, scoreThreshold);

  // 3. Run the single face detection + 68 landmarks (+ descriptor) pipeline
  let detectionResult: any = null;
  const timeoutMs = shouldExtractDescriptor ? 20000 : 15000;
  let timerId: any = null;

  try {
    const task = shouldExtractDescriptor && faceapi.nets.faceRecognitionNet.isLoaded
      ? faceapi.detectSingleFace(input, tinyOpts).withFaceLandmarks().withFaceDescriptor()
      : faceapi.detectSingleFace(input, tinyOpts).withFaceLandmarks();

    const timeoutPromise = new Promise<never>((_, reject) => {
      timerId = setTimeout(() => reject(new Error('Detector operation timed out')), timeoutMs);
    });

    detectionResult = await Promise.race([task, timeoutPromise]);
    if (timerId) clearTimeout(timerId);

    lastLoggedDetectorError = null;
    if (detectOpts?.onDetectorSuccess) {
      detectOpts.onDetectorSuccess();
    }
  } catch (err: any) {
    if (timerId) clearTimeout(timerId);
    const fullError = err?.message || String(err);
    const isTimeout = fullError.includes('timed out');

    if (isTimeout) {
      console.warn('[face-api.js] Frame detection deferred/timed out; continuing smoothly to next frame.');
    } else {
      const stack = err?.stack || '';
      const formattedError = stack ? `${fullError}\n${stack}` : fullError;
      lastLoggedDetectorError = formattedError;
      console.warn('[face-api.js] Detection frame notice:', err);
      if (detectOpts?.onDetectorError) {
        detectOpts.onDetectorError(formattedError);
      }
    }
    // Return null so the continuous webcam loop can smoothly continue to next frame instead of crashing
    return null;
  } finally {
    isDetectionInFlight = false;
  }

  // 4. If no face was detected in this frame, return null cleanly
  if (!detectionResult || !detectionResult.detection) {
    return null;
  }

  // 5. 68-point landmarks validation
  const landmarks = detectionResult.landmarks;
  let positions: any[] = [];
  if (landmarks) {
    if (Array.isArray(landmarks.positions)) {
      positions = landmarks.positions;
    } else if (Array.isArray((landmarks as any)._positions)) {
      positions = (landmarks as any)._positions;
    } else if (typeof (landmarks as any).getPositions === 'function') {
      positions = (landmarks as any).getPositions();
    } else if (Array.isArray(landmarks)) {
      positions = landmarks;
    }
  }
  const hasLandmarks = Boolean(positions && positions.length >= 68);

  const b = detectionResult.detection.box || detectionResult.box;
  const box = {
    x: b?.x ?? 0,
    y: b?.y ?? 0,
    width: b?.width ?? 0,
    height: b?.height ?? 0,
  };

  const inputW = (input as HTMLVideoElement).videoWidth || (input as HTMLCanvasElement).width || 640;
  const inputH = (input as HTMLVideoElement).videoHeight || (input as HTMLCanvasElement).height || 480;

  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  const normX = inputW > 0 ? centerX / inputW : 0.5;
  const normY = inputH > 0 ? centerY / inputH : 0.5;
  const isCentered = normX >= 0.05 && normX <= 0.95 && normY >= 0.05 && normY <= 0.95;

  if (!hasLandmarks) {
    return {
      detection: detectionResult.detection,
      landmarks: null,
      hasLandmarks: false,
      descriptor: undefined,
      ear: { leftEAR: 0.3, rightEAR: 0.3, avgEAR: 0.3 },
      pose: {
        physicalYaw: null,
        pose: 'UNKNOWN',
        isStraight: false,
        isPhysicalTurnLeft: false,
        isPhysicalTurnRight: false,
        normalizedNoseOffset: 0,
      },
      box,
      faceCount: 1,
      qualityScore: detectionResult.detection.score || 0.8,
      validation: {
        isValid: false,
        faceCount: 1,
        hasLandmarks: false,
      },
      isCentered,
      center: { x: centerX, y: centerY, normX, normY },
    };
  }

  const points = positions;
  const ear = calculateEAR(points);

  // 6. Pose calculation only after landmarks are confirmed
  const pose = calculateHeadPose(landmarks, neutralYawBaseline);

  const descriptor = detectionResult.descriptor ? Array.from(detectionResult.descriptor as Float32Array) : undefined;

  const validation: FaceValidationResult = {
    isValid: true,
    faceCount: 1,
    hasLandmarks: true,
  };

  return {
    detection: detectionResult.detection,
    landmarks: detectionResult.landmarks,
    hasLandmarks: true,
    descriptor,
    ear,
    pose,
    box,
    faceCount: 1,
    qualityScore: detectionResult.detection.score || 0.9,
    validation,
    isCentered,
    center: { x: centerX, y: centerY, normX, normY },
  };
}

/**
 * Configurable threshold for biometric duplicate face detection.
 * In face-api.js (128D L2-normalized Euclidean distance):
 * - Same person re-enrolling: distance is typically 0.15 - 0.32.
 * - Different individuals: distance is typically 0.48 - 0.75.
 * A conservative duplicate threshold of 0.40 ensures different people are never falsely
 * marked as duplicates, while genuine duplicate registrations are reliably flagged.
 */
export const FACE_MATCH_THRESHOLD = 0.40;

/**
 * Extracts and strictly validates a genuine 128-dimensional numeric descriptor vector.
 * Supports Array, Float32Array, and Firestore serialized maps.
 * Verifies:
 * 1. descriptor exists
 * 2. descriptor contains exactly 128 elements
 * 3. every element is a finite number (no NaN, no Infinity)
 * 4. vector is NOT all zeros
 * Returns the sanitized number[] array or null if invalid.
 */
export function toNumericDescriptor(descriptor: any): number[] | null {
  if (!descriptor) return null;
  let raw: any = descriptor;

  // Unpack nested fields if wrapped in a Firestore object
  if (raw && typeof raw === 'object') {
    if (Array.isArray(raw.vector)) raw = raw.vector;
    else if (Array.isArray(raw.descriptor)) raw = raw.descriptor;
    else if (Array.isArray(raw.faceDescriptor)) raw = raw.faceDescriptor;
    else if (Array.isArray(raw.faceEmbedding)) raw = raw.faceEmbedding;
  }

  let arr: number[] | null = null;
  if (Array.isArray(raw) || raw instanceof Float32Array) {
    arr = Array.from(raw);
  } else if (typeof raw === 'object' && raw !== null) {
    // Check if it is a Firestore serialized map with keys "0".."127"
    const keys = Object.keys(raw);
    if (keys.length === 128) {
      const converted: number[] = [];
      for (let i = 0; i < 128; i++) {
        const val = raw[i] ?? raw[String(i)];
        if (typeof val !== 'number' || !Number.isFinite(val) || isNaN(val)) {
          return null;
        }
        converted.push(val);
      }
      arr = converted;
    }
  }

  if (!arr || arr.length !== 128) return null;

  let allZeros = true;
  for (let i = 0; i < 128; i++) {
    const val = arr[i];
    if (typeof val !== 'number' || !Number.isFinite(val) || isNaN(val)) {
      return null;
    }
    if (val !== 0) {
      allZeros = false;
    }
  }

  // Reject all-zero vectors
  if (allZeros) return null;

  return arr;
}

/**
 * Validates that a biometric descriptor is a genuine 128-dimensional numeric vector
 * where all 128 values are finite numbers and not all zeros.
 */
export function isValidFaceDescriptor(descriptor: any): descriptor is number[] {
  return toNumericDescriptor(descriptor) !== null;
}

/**
 * Compares two 128-dimensional biometric face embeddings using Cosine Similarity.
 * Returns a score between -1 and 1, where > 0.85 indicates a strong facial match.
 */
export function calculateCosineSimilarity(vecA: any, vecB: any): number {
  const arrA = toNumericDescriptor(vecA);
  const arrB = toNumericDescriptor(vecB);
  if (!arrA || !arrB) {
    return 0;
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < 128; i++) {
    const a = arrA[i];
    const b = arrB[i];
    dotProduct += a * b;
    normA += a * a;
    normB += b * b;
  }

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Calculates the exact Euclidean distance between two 128-dimensional face descriptor vectors:
 * distance = sqrt( sum( (vecA[i] - vecB[i])^2 ) )
 * A distance closer to 0 indicates a higher biometric match.
 * Returns 999 if either vector is invalid.
 */
export function calculateEuclideanDistance(vecA: any, vecB: any): number {
  const arrA = toNumericDescriptor(vecA);
  const arrB = toNumericDescriptor(vecB);
  if (!arrA || !arrB) {
    return 999;
  }

  let sum = 0;
  for (let i = 0; i < 128; i++) {
    const diff = arrA[i] - arrB[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

/**
 * Formats a time string into 12-hour AM/PM format.
 */
export function formatTime12hr(time24?: string): string {
  if (!time24) return '--:--';
  const parts = time24.split(':');
  if (parts.length < 2) return time24;

  let hours = parseInt(parts[0]);
  const minutes = parts[1];
  const ampm = hours >= 12 ? 'PM' : 'AM';

  hours = hours % 12;
  hours = hours ? hours : 12;

  return `${hours.toString().padStart(2, '0')}:${minutes} ${ampm}`;
}

/**
 * Returns the current date in YYYY-MM-DD format based on local timezone.
 */
export function getLocalDateString(): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = (d.getMonth() + 1).toString().padStart(2, '0');
  const day = d.getDate().toString().padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Returns current local time in HH:MM format (24-hour).
 */
export function getLocalTimeString(): string {
  const d = new Date();
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

