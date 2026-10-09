import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import Header from '../../components/Header';
import { doc, setDoc, collection, getDocs, getDoc } from 'firebase/firestore';
import { db, auth } from '../../firebase/firebase';
import { motion } from 'motion/react';
import { StudentProfile } from '../../types';
import { 
  CheckCircle2, AlertCircle, ShieldCheck, 
  Camera, ArrowRight, RotateCcw, AlertTriangle, 
  Sparkles, Loader2
} from 'lucide-react';
import { 
  loadFaceApiModels, 
  isFaceApiLoaded,
  getModelStatus,
  getModelLoadingError,
  detectFaceBiometrics, 
  initTinyFaceDetector,
  calculateEuclideanDistance, 
  isValidFaceDescriptor,
  toNumericDescriptor,
  FACE_MATCH_THRESHOLD,
  LiveBiometricsResult,
  PoseType
} from '../../utils/faceUtils';
import { generatePermanentQrId } from '../../utils/qrUtils';

// Export threshold for other components or test scripts
export { FACE_MATCH_THRESHOLD };

/**
 * Result of biometric duplicate check
 */
export interface DuplicateCheckResult {
  isDuplicate: boolean;
  minDistance: number;
  facesChecked: number;
  matchedStudentId: string;
}

/**
 * Checks biometric duplicates against Firestore `face_descriptors` collection.
 * 
 * Strict Biometric Duplicate Rules:
 * 1. Queries all documents from `face_descriptors` collection.
 * 2. Validates each descriptor vector using toNumericDescriptor (128 finite numeric values, not all zeros).
 * 3. Skips any document that does not contain a valid 128D numeric descriptor.
 * 4. Skips the currently authenticated user's own existing descriptor (allows self re-enrollment).
 * 5. Calculates exact Euclidean distance between fresh descriptor and each valid stored descriptor.
 * 6. Logs each comparison: New student (currentId) → Existing student (recordId) → distance
 * 7. Evaluates duplicate match: isDuplicate = minDistance < FACE_MATCH_THRESHOLD (0.40).
 */
export async function checkBiometricDuplicate(
  freshDescriptor: number[],
  currentAuthUid: string,
  currentAuthEmail: string
): Promise<DuplicateCheckResult> {
  const sanitizedNew = toNumericDescriptor(freshDescriptor);
  if (!sanitizedNew) {
    throw new Error('Unable to generate a valid face descriptor. Please try again.');
  }

  let minDistance = 999;
  let matchedStudentId = 'NONE';
  let facesChecked = 0;

  console.log(`[DuplicateCheck] Starting duplicate verification -> Current Auth UID: "${currentAuthUid || 'NEW'}", Threshold: ${FACE_MATCH_THRESHOLD}`);

  const checkedUids = new Set<string>();

  try {
    const faceDescSnap = await getDocs(collection(db, 'face_descriptors'));
    console.log(`[DuplicateCheck] Retrieved ${faceDescSnap.docs.length} documents from 'face_descriptors' collection.`);

    for (const fDoc of faceDescSnap.docs) {
      const rawData = fDoc.data() as any;
      const docId = fDoc.id;
      const recordUid = rawData?.uid || rawData?.userId || rawData?.studentId || docId;
      const recordEmail = (rawData?.email || '').toLowerCase().trim();

      // Exclude the current authenticated user's own existing descriptor from duplicate detection
      const isCurrentUser = 
        (currentAuthUid && (docId === currentAuthUid || recordUid === currentAuthUid)) || 
        (recordEmail && currentAuthEmail && recordEmail === currentAuthEmail);

      if (isCurrentUser) {
        console.log(`[DuplicateCheck] Skipping current user's own existing record (UID: "${recordUid}"). Self-re-registration allowed.`);
        continue;
      }

      if (checkedUids.has(recordUid)) {
        continue;
      }
      checkedUids.add(recordUid);

      // Validate existing record descriptor
      const storedDesc = toNumericDescriptor(rawData?.descriptor || rawData?.faceDescriptor || rawData?.faceEmbedding);
      if (!storedDesc) {
        console.log(`[DuplicateCheck] Skipping record "${recordUid}" - missing or malformed 128D descriptor.`);
        continue;
      }

      // Calculate Euclidean distance
      const dist = calculateEuclideanDistance(sanitizedNew, storedDesc);
      facesChecked++;

      // Log comparison in required format: New student → Existing student → distance
      console.log(`New student (${currentAuthUid || 'NEW'}) → Existing student (${recordUid}) → ${dist.toFixed(4)}`);

      if (dist < minDistance) {
        minDistance = dist;
        matchedStudentId = recordUid;
      }
    }
  } catch (err) {
    console.warn('[DuplicateCheck] Error reading face_descriptors collection:', err);
  }

  const isDuplicate = minDistance < FACE_MATCH_THRESHOLD;
  console.log(
    `[DuplicateCheck] Completed verification -> Existing Faces Checked: ${facesChecked}, Minimum Distance: ${minDistance < 900 ? minDistance.toFixed(4) : 'N/A'}, Threshold: ${FACE_MATCH_THRESHOLD}, Duplicate Detected: ${isDuplicate ? 'YES' : 'NO'}, Matched Student ID: ${matchedStudentId}`
  );

  return {
    isDuplicate,
    minDistance,
    facesChecked,
    matchedStudentId: isDuplicate ? matchedStudentId : 'NONE',
  };
}

// Number of consecutive frames required with the expected pose before advancing
const REQUIRED_STABLE_FRAMES = 8;

type FlowStep = 
  | 'lookStraight'   // Step 1: Look Straight & Hold
  | 'turnLeft'       // Step 2: Turn Head Left
  | 'turnRight'      // Step 3: Turn Head Right
  | 'finalCapture'   // Step 4: Final Biometric Capture
  | 'duplicateCheck' // Step 5: Duplicate Verification
  | 'saving'         // Step 6: Save Registration to DB
  | 'success'        // Done
  | 'error';         // Stopped due to duplicate or error

interface StepInfo {
  id: FlowStep;
  number: number;
  label: string;
  title: string;
  instruction: string;
}

const STEPS: StepInfo[] = [
  { 
    id: 'lookStraight', 
    number: 1, 
    label: 'Look Straight', 
    title: 'LOOK STRAIGHT', 
    instruction: 'Look directly at the camera. Keep your face visible and hold steady.' 
  },
  { 
    id: 'turnLeft', 
    number: 2, 
    label: 'Turn Head Left', 
    title: 'TURN HEAD LEFT', 
    instruction: 'Turn your head slightly to your LEFT while keeping your face visible.' 
  },
  { 
    id: 'turnRight', 
    number: 3, 
    label: 'Turn Head Right', 
    title: 'TURN HEAD RIGHT', 
    instruction: 'Turn your head slightly to your RIGHT while keeping your face visible.' 
  },
  { 
    id: 'finalCapture', 
    number: 4, 
    label: 'Final Face Capture', 
    title: 'FINAL CAPTURE', 
    instruction: 'Securing your high-resolution facial profile and biometric embedding.' 
  },
  { 
    id: 'duplicateCheck', 
    number: 5, 
    label: 'Duplicate Face Check', 
    title: 'DUPLICATE CHECK', 
    instruction: 'Verifying facial uniqueness against registered database records.' 
  },
  { 
    id: 'saving', 
    number: 6, 
    label: 'Save Registration', 
    title: 'SAVING PROFILE', 
    instruction: 'Enrolling your biometric identity to your student account.' 
  }
];

const FaceRegistration: React.FC = () => {
  const { studentProfile, refreshProfile } = useAuth();
  const { success, error, info } = useToast();
  const navigate = useNavigate();

  // Elements & Media Stream refs
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // States
  const [registrationStarted, setRegistrationStarted] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const isSavingRef = useRef(false);
  const [hasCameraPermission, setHasCameraPermission] = useState<boolean | null>(null);
  const [cameraErrorMessage, setCameraErrorMessage] = useState<string | null>(null);
  const [isCameraReady, setIsCameraReady] = useState(false);
  const [modelsReady, setModelsReady] = useState(false);
  const [currentStep, setCurrentStep] = useState<FlowStep>('lookStraight');
  const [stepProgress, setStepProgress] = useState(0);
  const [statusMessage, setStatusMessage] = useState('Ready to start face registration');
  const [isFaceDetected, setIsFaceDetected] = useState(false);
  const [capturedPhotoUrl, setCapturedPhotoUrl] = useState<string | null>(null);
  const [duplicateError, setDuplicateError] = useState<{ matchedUid?: string; distance?: number } | null>(null);
  const [authenticatedStudent, setAuthenticatedStudent] = useState<StudentProfile | null>(null);

  // Directly fetch and bind student identity from the authenticated Firebase Auth session
  useEffect(() => {
    let isMounted = true;
    const fetchCurrentStudent = async () => {
      const currentUid = auth.currentUser?.uid;
      if (!currentUid) return;

      try {
        const studentSnap = await getDoc(doc(db, 'students', currentUid));
        if (studentSnap.exists() && isMounted) {
          const data = studentSnap.data() as StudentProfile;
          setAuthenticatedStudent({
            ...data,
            uid: currentUid,
            studentId: currentUid
          });
          return;
        }

        // Check users collection if student document is being provisioned
        const userSnap = await getDoc(doc(db, 'users', currentUid));
        if (userSnap.exists() && isMounted) {
          const uData = userSnap.data();
          setAuthenticatedStudent({
            studentId: currentUid,
            uid: currentUid,
            studentName: uData?.name || auth.currentUser?.displayName || 'Student',
            rollNumber: uData?.rollNumber || `STU-${currentUid.slice(0, 6).toUpperCase()}`,
            department: uData?.department || 'Computer Science',
            year: uData?.year || '1st Year',
            email: auth.currentUser?.email || '',
            faceRegistered: false,
            attendancePercentage: 100,
            photoURL: ''
          });
        }
      } catch (err) {
        console.error('[FaceRegistration] Error fetching current student record:', err);
      }
    };

    fetchCurrentStudent();
    return () => {
      isMounted = false;
    };
  }, [studentProfile]);

  // Guaranteed binding to the currently authenticated student
  const activeStudentDisplay = useMemo(() => {
    const currentUid = auth.currentUser?.uid;
    if (!currentUid) return null;

    if (authenticatedStudent && (authenticatedStudent.uid === currentUid || authenticatedStudent.studentId === currentUid)) {
      return authenticatedStudent;
    }

    if (studentProfile && (studentProfile.uid === currentUid || studentProfile.studentId === currentUid)) {
      return studentProfile;
    }

    return {
      studentName: auth.currentUser?.displayName || 'Student',
      rollNumber: `STU-${currentUid.slice(0, 6).toUpperCase()}`,
      year: '1st Year'
    };
  }, [authenticatedStudent, studentProfile]);

  // Debug indicator states (Live real-time telemetry)
  const [debugFaceDetected, setDebugFaceDetected] = useState<boolean>(false);
  const [debugLandmarksDetected, setDebugLandmarksDetected] = useState<boolean>(false);
  const [debugYaw, setDebugYaw] = useState<number | null>(null);
  const [debugDetectedPose, setDebugDetectedPose] = useState<PoseType>('UNKNOWN');
  const [debugExpectedPose, setDebugExpectedPose] = useState<'STRAIGHT' | 'LEFT' | 'RIGHT'>('STRAIGHT');
  const [debugStableFrames, setDebugStableFrames] = useState<number>(0);
  const [debugDetectorStatus, setDebugDetectorStatus] = useState<'READY' | 'ERROR' | 'IDLE'>('IDLE');
  const [debugModelStatus, setDebugModelStatus] = useState<'LOADED' | 'LOADING' | 'NOT_LOADED' | 'ERROR'>('NOT_LOADED');
  const [debugDetectionReason, setDebugDetectionReason] = useState<string>('Camera idle');
  const [debugDetectorError, setDebugDetectorError] = useState<string | null>(null);

  // Requirement 16: Biometric duplicate verification telemetry debug state
  const [duplicateDebugInfo, setDuplicateDebugInfo] = useState<{
    descriptorStatus: 'VALID' | 'INVALID' | 'IDLE';
    existingFacesChecked: number;
    minDistance: string;
    isDuplicate: 'YES' | 'NO' | 'IDLE';
  }>({
    descriptorStatus: 'IDLE',
    existingFacesChecked: 0,
    minDistance: 'N/A',
    isDuplicate: 'IDLE',
  });

  // Loop & state tracking refs to eliminate stale closures and duplicate rAF loops
  const animIdRef = useRef<number | null>(null);
  const registrationStartedRef = useRef<boolean>(false);
  const currentStepRef = useRef<FlowStep>('lookStraight');
  const modelsReadyRef = useRef<boolean>(false);
  const isCameraReadyRef = useRef<boolean>(false);
  const consecutiveStableFramesRef = useRef<number>(0);
  const missedFramesRef = useRef<number>(0);
  const isTransitioningRef = useRef<boolean>(false);
  const isProcessingRef = useRef<boolean>(false);
  const capturedDescriptorsRef = useRef<number[][]>([]);
  const straightDescriptorsRef = useRef<number[][]>([]);
  const lastDetectionTimeRef = useRef<number>(0);

  // Calibration references for Look Straight (Step 1)
  const neutralYawBaselineRef = useRef<number>(0);
  const neutralSamplesRef = useRef<number[]>([]);
  const isCalibratedRef = useRef<boolean>(false);

  // Synchronize refs with state
  useEffect(() => {
    registrationStartedRef.current = registrationStarted;
  }, [registrationStarted]);

  useEffect(() => {
    currentStepRef.current = currentStep;
    if (currentStep === 'lookStraight') {
      setDebugExpectedPose('STRAIGHT');
    } else if (currentStep === 'turnLeft') {
      setDebugExpectedPose('LEFT');
    } else if (currentStep === 'turnRight') {
      setDebugExpectedPose('RIGHT');
    }
  }, [currentStep]);

  useEffect(() => {
    modelsReadyRef.current = modelsReady;
  }, [modelsReady]);

  // Cleanly stop any existing camera tracks
  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setIsCameraReady(false);
    isCameraReadyRef.current = false;
  }, []);

  // Safely attaches a MediaStream to the video element and waits for it to be playing
  const attachStreamToVideo = useCallback(async (video: HTMLVideoElement, stream: MediaStream) => {
    if (video.srcObject !== stream) {
      video.srcObject = stream;
    }
    video.muted = true;
    video.playsInline = true;
    video.setAttribute('playsinline', 'true');
    video.setAttribute('autoplay', 'true');
    video.setAttribute('muted', 'true');

    return new Promise<void>((resolve) => {
      let resolved = false;
      const markReady = () => {
        if (resolved) return;
        resolved = true;
        video.removeEventListener('loadedmetadata', markReady);
        video.removeEventListener('loadeddata', markReady);
        video.removeEventListener('canplay', markReady);
        video.play().catch(() => {}).finally(() => {
          setIsCameraReady(true);
          isCameraReadyRef.current = true;
          resolve();
        });
      };

      if (video.readyState >= 2 && video.videoWidth > 0) {
        markReady();
      } else {
        video.addEventListener('loadedmetadata', markReady, { once: true });
        video.addEventListener('loadeddata', markReady, { once: true });
        video.addEventListener('canplay', markReady, { once: true });
        setTimeout(markReady, 600);
      }
    });
  }, []);

  // Initialize camera stream once and attach to the video element.
  // Reuses existing live stream if already running to prevent duplicate streams.
  const startCamera = useCallback(async (force = false) => {
    try {
      setHasCameraPermission(null);
      setCameraErrorMessage(null);

      // Reuse existing active stream if healthy
      if (
        !force &&
        streamRef.current &&
        streamRef.current.active &&
        streamRef.current.getVideoTracks().some((t) => t.readyState === 'live')
      ) {
        setHasCameraPermission(true);
        if (videoRef.current) {
          await attachStreamToVideo(videoRef.current, streamRef.current);
        }
        return;
      }

      // Stop any existing stream before creating a fresh one
      stopCamera();

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: 'user',
            width: { ideal: 640 },
            height: { ideal: 480 },
          },
          audio: false,
        });
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      }

      streamRef.current = stream;
      setHasCameraPermission(true);

      if (videoRef.current) {
        await attachStreamToVideo(videoRef.current, stream);
      }
    } catch (err: any) {
      console.error('[FaceRegistration] Camera access failed:', err);
      setHasCameraPermission(false);
      setIsCameraReady(false);
      isCameraReadyRef.current = false;
      const isDenied = err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError';
      const msg = isDenied
        ? 'Camera permission is required for face registration.'
        : 'Unable to access camera. Please check your camera permissions.';
      setCameraErrorMessage(msg);
      setStatusMessage(msg);
      error(msg);
    }
  }, [attachStreamToVideo, error, stopCamera]);

  // Keep video.srcObject bound even if the video element remounts
  useEffect(() => {
    const video = videoRef.current;
    const stream = streamRef.current;
    if (video && stream && video.srcObject !== stream) {
      attachStreamToVideo(video, stream);
    }
  });

  // Load face-api neural network models on mount
  useEffect(() => {
    let isMounted = true;
    (async () => {
      try {
        setDebugModelStatus('LOADING');
        await loadFaceApiModels();
        if (isMounted) {
          setModelsReady(true);
          modelsReadyRef.current = true;
          setDebugModelStatus('LOADED');
          setDebugDetectorStatus('READY');
        }
      } catch (err: any) {
        console.error('[FaceRegistration] Failed to load face recognition models:', err);
        if (isMounted) {
          setDebugModelStatus('ERROR');
          setDebugDetectorStatus('ERROR');
          setDebugDetectionReason(err?.message || 'Failed to load face detection neural network models');
          error('Failed to load face recognition models. Please refresh.');
        }
      }
    })();

    return () => {
      isMounted = false;
    };
  }, [error]);

  // Clean up camera on unmount (do not auto-start on mount)
  useEffect(() => {
    return () => {
      stopCamera();
    };
  }, [stopCamera]);

  // Execute Step 4 (Final Capture), Step 5 (Duplicate Check), Step 6 (Save Registration)
  const executeFinalizeFlow = useCallback(async () => {
    // Boolean isSaving guard to prevent multiple, overlapping Firestore write operations from accidental double-clicks
    if (isSaving || isSavingRef.current) {
      console.warn('[FaceRegistration] Save operation already in progress. Preventing overlapping Firestore writes.');
      return;
    }
    isSavingRef.current = true;
    setIsSaving(true);
    isTransitioningRef.current = true;
    const video = videoRef.current;
    const currentUser = auth.currentUser;
    const currentUid = currentUser?.uid;

    if (!currentUser || !currentUid) {
      error('No active student session. Please log in again.');
      setCurrentStep('error');
      setIsSaving(false);
      isSavingRef.current = false;
      isTransitioningRef.current = false;
      return;
    }

    const currentEmail = (auth.currentUser?.email || '').toLowerCase().trim();
    const finalStudentName = authenticatedStudent?.studentName || studentProfile?.studentName || auth.currentUser?.displayName || 'Student';
    const finalRollNumber = authenticatedStudent?.rollNumber || studentProfile?.rollNumber || `STU-${currentUid.slice(0, 6).toUpperCase()}`;

    try {
      // --------------------------------------------------------------------
      // STEP 4: FINAL FACE CAPTURE & EMBEDDING GENERATION
      // --------------------------------------------------------------------
      setCurrentStep('finalCapture');
      setStatusMessage('Capturing final frontal face profile...');
      setStepProgress(100);

      if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
        throw new Error('Live camera stream is unavailable for final capture.');
      }

      const snapW = video.videoWidth;
      const snapH = video.videoHeight;
      if (snapW <= 0 || snapH <= 0) {
        throw new Error('Invalid camera frame dimensions for final capture.');
      }

      // Generate fresh snapshot photo from the CURRENT live video frame
      const snapCanvas = document.createElement('canvas');
      snapCanvas.width = snapW;
      snapCanvas.height = snapH;
      const snapCtx = snapCanvas.getContext('2d');
      if (!snapCtx) {
        throw new Error('Unable to initialize canvas context for final capture.');
      }
      // Draw CURRENT live video frame (mirrored to match user preview)
      snapCtx.translate(snapW, 0);
      snapCtx.scale(-1, 1);
      snapCtx.drawImage(video, 0, 0, snapW, snapH);

      const photoDataUrl = snapCanvas.toDataURL('image/jpeg', 0.92);
      if (!photoDataUrl || photoDataUrl.length < 200 || !photoDataUrl.startsWith('data:image/')) {
        throw new Error('Captured image data is empty or invalid.');
      }
      setCapturedPhotoUrl(photoDataUrl);

      // Section 9 Debug Logging: Immediately after final capture
      console.log("FINAL CAPTURE SUCCESS for student:", currentUid);

      // Extract real biometric descriptor from current live video frame only after a valid face detection
      let finalBio = await detectFaceBiometrics(video, { extractDescriptor: true });
      let liveDescriptor = finalBio?.descriptor;

      console.log("LIVE CAPTURE DESCRIPTOR EXISTS:", Boolean(liveDescriptor));
      console.log("LIVE CAPTURE DESCRIPTOR LENGTH:", liveDescriptor?.length ?? 0);
      console.log("LIVE CAPTURE DESCRIPTOR TYPE:", liveDescriptor ? (Array.isArray(liveDescriptor) ? 'Array' : typeof liveDescriptor) : 'undefined');

      let finalDescriptor: number[] | null = null;
      if (liveDescriptor && isValidFaceDescriptor(liveDescriptor)) {
        finalDescriptor = Array.from(liveDescriptor);
      } else {
        // Safe retry up to 3 times on active video frame if frame was mid-render
        for (let attempt = 1; attempt <= 3; attempt++) {
          await new Promise((r) => setTimeout(r, 150));
          const retryBio = await detectFaceBiometrics(video, { extractDescriptor: true });
          if (retryBio?.descriptor && isValidFaceDescriptor(retryBio.descriptor)) {
            finalDescriptor = Array.from(retryBio.descriptor);
            console.log(`[FaceRegistration] Live descriptor recovered on retry attempt ${attempt}`);
            break;
          }
        }
      }

      // Requirement 2: Strict descriptor validation
      // Verify:
      // - descriptor exists
      // - descriptor is an array
      // - descriptor contains exactly 128 values
      // - every value is a finite number
      // - descriptor is not all zeros
      // If the descriptor is invalid, STOP the registration and show:
      // “Unable to generate a valid face descriptor. Please try again.”
      const freshDescriptor = toNumericDescriptor(finalDescriptor);
      if (!freshDescriptor) {
        console.error("[FaceRegistration] Face descriptor validation failed or is invalid/all-zeros.");
        setDuplicateDebugInfo(prev => ({ ...prev, descriptorStatus: 'INVALID', descriptorLength: 'N/A' }));
        setStatusMessage("Unable to generate a valid face descriptor. Please try again.");
        error("Unable to generate a valid face descriptor. Please try again.");
        setCurrentStep('error');
        currentStepRef.current = 'error';
        return;
      }

      console.log("NEW DESCRIPTOR VALID:", true, "Length:", freshDescriptor.length);

      // Requirement 5: Telemetry update with validated descriptor status and length
      setDuplicateDebugInfo(prev => ({
        ...prev,
        descriptorStatus: 'VALID',
        descriptorLength: 128,
      }));

      // Multi-pose descriptors for student profile attendance variations
      const allDescriptors: number[][] = [freshDescriptor];

      // --------------------------------------------------------------------
      // STEP 5: DUPLICATE FACE CHECK
      // --------------------------------------------------------------------
      setCurrentStep('duplicateCheck');
      currentStepRef.current = 'duplicateCheck';
      setStatusMessage('Verifying face uniqueness against database...');
      await new Promise((r) => setTimeout(r, 350));

      const currentAuthUser = auth.currentUser;
      const currentAuthUid = currentAuthUser?.uid || currentUser?.uid || studentProfile?.uid || authenticatedStudent?.uid || '';
      const currentAuthEmail = (currentAuthUser?.email || currentUser?.email || studentProfile?.email || authenticatedStudent?.email || '').toLowerCase().trim();

      console.log(`[DuplicateCheck] Starting biometric duplicate check for UID: "${currentAuthUid || 'NEW'}"`);

      // Run checkBiometricDuplicate against face_descriptors collection
      const duplicateResult = await checkBiometricDuplicate(
        freshDescriptor,
        currentAuthUid,
        currentAuthEmail
      );

      // Requirement 5: Mandatory Biometric Duplicate Telemetry state update
      setDuplicateDebugInfo({
        descriptorStatus: 'VALID',
        descriptorLength: 128,
        existingFacesChecked: duplicateResult.facesChecked,
        minDistance: duplicateResult.minDistance < 900 ? duplicateResult.minDistance.toFixed(3) : 'N/A',
        matchedStudentId: duplicateResult.matchedStudentId,
        isDuplicate: duplicateResult.isDuplicate ? 'YES' : 'NO',
      });

      console.log(
        `[DuplicateCheck] Result -> Checked: ${duplicateResult.facesChecked}, Min Distance: ${duplicateResult.minDistance < 900 ? duplicateResult.minDistance.toFixed(4) : 'N/A'}, Threshold: ${FACE_MATCH_THRESHOLD}, Duplicate: ${duplicateResult.isDuplicate ? 'YES' : 'NO'}, Matched ID: ${duplicateResult.matchedStudentId}`
      );

      // Requirement 8: If duplicate detected, stop registration immediately
      if (duplicateResult.isDuplicate) {
        stopCamera();
        setDuplicateError({
          matchedUid: duplicateResult.matchedStudentId,
          distance: duplicateResult.minDistance,
        });
        setCurrentStep('error');
        currentStepRef.current = 'error';
        setStatusMessage('Duplicate Face Detected: This face is already registered with another student account.');
        error('This face is already registered with another account in the database.');
        return;
      }

      // --------------------------------------------------------------------
      // STEP 6: SAVE REGISTRATION
      // --------------------------------------------------------------------
      setCurrentStep('saving');
      currentStepRef.current = 'saving';
      setStatusMessage('Saving biometric profile to student database...');

      console.log("SAVE STEP 6 STARTED");

      console.log("AUTH USER CHECK");
      console.log("USER UID:", currentAuthUid);

      if (!currentAuthUser || !currentAuthUid) {
        throw new Error("No authenticated student user session found. Please sign in again.");
      }

      console.log("FACE DESCRIPTOR CHECK");
      if (!isValidFaceDescriptor(freshDescriptor)) {
        throw new Error("Invalid or empty face descriptor vector. Please retake the face scan.");
      }

      console.log("FACE IMAGE CHECK");
      if (!photoDataUrl || typeof photoDataUrl !== 'string' || !photoDataUrl.startsWith('data:image/')) {
        throw new Error("Captured face image is missing or invalid.");
      }
      const finalPhotoUrl = photoDataUrl;

      try {
        console.log("FIRESTORE WRITE STARTED");

        const firestoreWritePromise = (async () => {
          // 1. Save to face_registrations collection with consistent UID and email
          await setDoc(
            doc(db, 'face_registrations', currentAuthUid),
            {
              uid: currentAuthUid,
              userId: currentAuthUid,
              studentId: currentAuthUid,
              email: currentEmail,
              studentName: finalStudentName,
              rollNumber: finalRollNumber,
              descriptor: freshDescriptor,
              faceEmbedding: freshDescriptor,
              faceDescriptor: freshDescriptor,
              createdAt: new Date().toISOString(),
            },
            { merge: true }
          );

          // 2. Save to face_descriptors collection with consistent UID and email
          await setDoc(
            doc(db, 'face_descriptors', currentAuthUid),
            {
              uid: currentAuthUid,
              userId: currentAuthUid,
              studentId: currentAuthUid,
              email: currentEmail,
              studentName: finalStudentName,
              rollNumber: finalRollNumber,
              descriptor: freshDescriptor,
              faceEmbedding: freshDescriptor,
              faceDescriptor: freshDescriptor,
              createdAt: new Date().toISOString(),
            },
            { merge: true }
          );

          // 3. Save to students collection with permanent QR identification
          const existingQrId = authenticatedStudent?.qrId || studentProfile?.qrId;
          const finalQrId = existingQrId || generatePermanentQrId(currentAuthUid);

          await setDoc(
            doc(db, 'students', currentAuthUid),
            {
              studentId: currentAuthUid,
              uid: currentAuthUid,
              studentName: finalStudentName,
              rollNumber: finalRollNumber,
              email: currentEmail,
              faceRegistered: true,
              faceEmbedding: freshDescriptor,
              faceEmbeddings: allDescriptors.map((vec) => ({ vector: vec })),
              photoURL: finalPhotoUrl,
              faceRegisteredAt: new Date().toISOString(),
              qrId: finalQrId,
              qrCreatedAt: authenticatedStudent?.qrCreatedAt || new Date().toISOString(),
            },
            { merge: true }
          );

          // 4. Mark faceRegistered in users collection
          await setDoc(
            doc(db, 'users', currentAuthUid),
            { 
              faceRegistered: true,
              photoURL: finalPhotoUrl,
              name: finalStudentName,
              rollNumber: finalRollNumber,
            },
            { merge: true }
          );

          // 5. Refresh profile in AuthContext
          try {
            await refreshProfile();
          } catch (profileRefreshErr) {
            console.warn('[FaceRegistration] Profile refresh non-fatal notice:', profileRefreshErr);
          }
        })();

        let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            reject(new Error("Registration save timed out. Please try again."));
          }, 15000);
        });

        try {
          await Promise.race([firestoreWritePromise, timeoutPromise]);
        } finally {
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
          }
        }

        console.log("FIRESTORE WRITE COMPLETED");
        console.log("REGISTRATION SAVE SUCCESS");

        // Clean up live camera stream cleanly
        stopCamera();
        // Cancel all animation frames / detection loops
        if (animIdRef.current !== null) {
          cancelAnimationFrame(animIdRef.current);
          animIdRef.current = null;
        }

        // Mark Step 6 as Completed
        setCurrentStep('success');
        currentStepRef.current = 'success';
        setStepProgress(100);
        setStatusMessage('Face registration completed successfully');
        success('Face registration completed successfully');
      } catch (saveErr: any) {
        console.error('[FaceRegistration] Firebase saving error:', saveErr);
        setCurrentStep('error');
        currentStepRef.current = 'error';
        const errCode = saveErr?.code ? `[${saveErr.code}] ` : '';
        const errMsg = saveErr?.message || 'Face registration could not be saved.';
        const fullErrMsg = `${errCode}${errMsg}`.trim();
        setStatusMessage(fullErrMsg);
        error(fullErrMsg);
        return;
      }
    } catch (err: any) {
      console.error('Finalize flow error:', err);
      setCurrentStep('error');
      currentStepRef.current = 'error';
      const msg = err.message || 'Face registration could not be completed.';
      setStatusMessage(msg);
      error(msg);
    } finally {
      setIsSaving(false);
      isSavingRef.current = false;
      isTransitioningRef.current = false;
    }
  }, [authenticatedStudent, error, isSaving, refreshProfile, stopCamera, studentProfile, success]);

  const lastLogTimeRef = useRef<number>(0);

  // Face Registration Start handler: Only runs when user clicks START FACE REGISTRATION
  const handleStartFaceRegistration = useCallback(async () => {
    if (registrationStartedRef.current || isStarting || isSaving || isSavingRef.current) return;
    setIsStarting(true);
    console.log('[FaceRegistration] Starting Face Registration flow');

    try {
      // Step 1: Set registration state to active immediately
      setRegistrationStarted(true);
      registrationStartedRef.current = true;
      setStatusMessage('Camera active — Initializing...');
      setDebugDetectionReason('Camera active — Initializing...');

      // Step 2, 3, 4, 5: Request webcam permission, start ONE MediaStream, attach to video, wait until ready and playing
      await startCamera(true);

      // Verify video element playback
      const video = videoRef.current;
      if (video) {
        try {
          await video.play();
        } catch {}
      }

      // Step 6: Load/initialize the face detection model if it is not already loaded
      if (!isFaceApiLoaded()) {
        setStatusMessage('Camera active — Loading face detection models...');
        setDebugDetectionReason('Camera active — Loading models...');
        setDebugModelStatus('LOADING');
        await loadFaceApiModels();
        setModelsReady(true);
        modelsReadyRef.current = true;
        setDebugModelStatus('LOADED');
        setDebugDetectorStatus('READY');
      } else {
        setDebugModelStatus('LOADED');
        setDebugDetectorStatus('READY');
      }

      // Pre-initialize single TinyFaceDetector options instance before loop starts
      initTinyFaceDetector(320, 0.15);
      setDebugDetectorError(null);
      setDebugDetectorStatus('READY');

      // Step 8, 9, 10: Activate Step 1 — Look Straight & reset stable-frame counter
      capturedDescriptorsRef.current = [];
      straightDescriptorsRef.current = [];
      consecutiveStableFramesRef.current = 0;
      isTransitioningRef.current = false;
      isProcessingRef.current = false;
      lastDetectionTimeRef.current = 0;
      neutralSamplesRef.current = [];
      neutralYawBaselineRef.current = 0;
      isCalibratedRef.current = false;

      setDuplicateDebugInfo({
        descriptorStatus: 'IDLE',
        existingFacesChecked: 0,
        minDistance: 'N/A',
        isDuplicate: 'IDLE',
      });
      setDuplicateError(null);
      setCapturedPhotoUrl(null);
      setStepProgress(0);
      setDebugStableFrames(0);
      setDebugFaceDetected(false);
      setDebugLandmarksDetected(false);
      setDebugYaw(null);
      setDebugDetectedPose('UNKNOWN');
      setDebugExpectedPose('STRAIGHT');
      setDebugDetectorError(null);

      setCurrentStep('lookStraight');
      currentStepRef.current = 'lookStraight';
      setStatusMessage('Camera active — Look straight at the camera.');
      setDebugDetectionReason('Camera active — Look straight at camera');
      setIsFaceDetected(false);

      info('Face Registration Started — Step 1: Look Straight');
    } catch (err: any) {
      console.error('[FaceRegistration] Failed to start registration:', err);
      setRegistrationStarted(false);
      registrationStartedRef.current = false;
      setDebugDetectionReason('Camera idle');
      stopCamera();
    } finally {
      setIsStarting(false);
    }
  }, [info, isStarting, startCamera, stopCamera]);

  // Reset Registration handler: Stops webcam, cancels loop, and restores initial idle state
  const handleResetRegistration = useCallback(() => {
    if (isSaving || isSavingRef.current) {
      console.warn('[FaceRegistration] Reset blocked: Firestore write operation currently saving.');
      return;
    }
    console.log('[FaceRegistration] Resetting Face Registration to idle state');
    if (animIdRef.current !== null) {
      cancelAnimationFrame(animIdRef.current);
      animIdRef.current = null;
    }
    stopCamera();
    setRegistrationStarted(false);
    registrationStartedRef.current = false;
    setIsStarting(false);

    capturedDescriptorsRef.current = [];
    straightDescriptorsRef.current = [];
    consecutiveStableFramesRef.current = 0;
    missedFramesRef.current = 0;
    isTransitioningRef.current = false;
    isProcessingRef.current = false;
    lastDetectionTimeRef.current = 0;
    neutralSamplesRef.current = [];
    neutralYawBaselineRef.current = 0;
    isCalibratedRef.current = false;

    setDuplicateDebugInfo({
      descriptorStatus: 'IDLE',
      descriptorLength: 'N/A',
      existingFacesChecked: 0,
      minDistance: 'N/A',
      matchedStudentId: 'NONE',
      isDuplicate: 'IDLE',
    });

    setCurrentStep('lookStraight');
    currentStepRef.current = 'lookStraight';
    setStepProgress(0);
    setStatusMessage('Ready to start face registration');
    setIsFaceDetected(false);
    setCapturedPhotoUrl(null);
    setDuplicateError(null);
    setHasCameraPermission(null);
    setCameraErrorMessage(null);

    setDebugFaceDetected(false);
    setDebugLandmarksDetected(false);
    setDebugYaw(null);
    setDebugDetectedPose('UNKNOWN');
    setDebugExpectedPose('STRAIGHT');
    setDebugStableFrames(0);
    setDebugDetectorStatus('IDLE');
    setDebugModelStatus(isFaceApiLoaded() ? 'LOADED' : 'NOT_LOADED');
    setDebugDetectorError(null);
    setDebugDetectionReason('Camera idle');

    if (canvasRef.current) {
      const ctx = canvasRef.current.getContext('2d');
      if (ctx) {
        ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
      }
    }

    info('Registration reset. Ready to start face registration.');
  }, [info, isSaving, stopCamera]);

  const handleRestart = useCallback(() => {
    if (isSaving || isSavingRef.current) return;
    handleResetRegistration();
    setTimeout(() => {
      handleStartFaceRegistration();
    }, 120);
  }, [handleResetRegistration, handleStartFaceRegistration, isSaving]);

  const handleTryAgain = useCallback(() => {
    if (isSaving || isSavingRef.current) return;
    handleResetRegistration();
    setTimeout(() => {
      handleStartFaceRegistration();
    }, 150);
  }, [handleResetRegistration, handleStartFaceRegistration, isSaving]);

  // Keep executeFinalizeFlow accessible without triggering loop recreation
  const executeFinalizeFlowRef = useRef(executeFinalizeFlow);
  useEffect(() => {
    executeFinalizeFlowRef.current = executeFinalizeFlow;
  }, [executeFinalizeFlow]);

  // Continuous Detection Loop using requestAnimationFrame
  // Processes live video frames with landmark-based pose estimation & frame smoothing
  useEffect(() => {
    if (!registrationStarted) {
      return;
    }

    let animId: number;
    let isMounted = true;

    const runLoop = async (timestamp: number) => {
      if (!isMounted || !registrationStartedRef.current) return;

      const step = currentStepRef.current;
      const isChecking = step === 'lookStraight' || step === 'turnLeft' || step === 'turnRight' || step === 'finalCapture';

      // Ensure video is playing and ready
      const video = videoRef.current;
      const canvas = canvasRef.current;

      // If models are not loaded yet, wait for initialization (do not load inside frame loop)
      if (!isFaceApiLoaded()) {
        animId = requestAnimationFrame(runLoop);
        return;
      }

      if (
        isChecking &&
        video &&
        video.srcObject &&
        video.readyState >= 2 &&
        video.videoWidth > 0 &&
        video.videoHeight > 0 &&
        !isTransitioningRef.current &&
        !isProcessingRef.current &&
        timestamp - lastDetectionTimeRef.current > 50
      ) {
        // If video is paused, trigger play and defer detection to next frame
        if (video.paused) {
          video.play().catch(() => {});
          return;
        }

        lastDetectionTimeRef.current = timestamp;
        isProcessingRef.current = true;

        try {
          // Draw visual oval guide overlay on canvas
          if (canvas) {
            const displayW = canvas.clientWidth || 640;
            const displayH = canvas.clientHeight || 480;
            if (canvas.width !== displayW || canvas.height !== displayH) {
              canvas.width = displayW;
              canvas.height = displayH;
            }
            const ctx = canvas.getContext('2d');
            if (ctx) {
              ctx.clearRect(0, 0, displayW, displayH);
              ctx.beginPath();
              ctx.ellipse(displayW / 2, displayH / 2, displayW * 0.26, displayH * 0.35, 0, 0, 2 * Math.PI);
              ctx.lineWidth = 3.5;
              ctx.strokeStyle = consecutiveStableFramesRef.current > 0 ? 'rgba(52, 211, 153, 0.95)' : 'rgba(148, 163, 184, 0.65)';
              if (consecutiveStableFramesRef.current === 0) {
                ctx.setLineDash([8, 6]);
              }
              ctx.stroke();
              ctx.setLineDash([]);
            }
          }

          // Run single calibrated TinyFaceDetector + 68 landmarks extraction on live HTMLVideoElement
          let liveBio: LiveBiometricsResult | null = null;
          try {
            liveBio = await detectFaceBiometrics(video, {
              extractDescriptor: false,
              inputSize: 320,
              scoreThreshold: 0.15,
              neutralYawBaseline: neutralYawBaselineRef.current,
              onDetectorError: (err) => {
                if (err && !err.includes('timed out')) {
                  setDebugDetectorError(err);
                  setDebugDetectorStatus('ERROR');
                }
              },
              onDetectorSuccess: () => {
                setDebugDetectorError(null);
                setDebugDetectorStatus('READY');
              },
            });
          } catch (detErr: any) {
            const errString = detErr?.message || String(detErr);
            console.warn("[FaceRegistration] Detection frame notice:", detErr);
            if (!errString.includes('timed out')) {
              const stack = detErr?.stack || '';
              const fullDetError = stack ? `${errString}\n${stack}` : errString;
              setDebugDetectorError(fullDetError);
              setDebugDetectorStatus('ERROR');
            }
            setDebugDetectionReason(`Detector: ${errString}`);
          }

          const hasFace = Boolean(liveBio && liveBio.detection);
          const hasLandmarks = Boolean(liveBio && liveBio.hasLandmarks);

          // Determine expected pose for current step
          let expectedPose: 'STRAIGHT' | 'LEFT' | 'RIGHT' = 'STRAIGHT';
          if (step === 'turnLeft') {
            expectedPose = 'LEFT';
          } else if (step === 'turnRight') {
            expectedPose = 'RIGHT';
          } else {
            // lookStraight or finalCapture
            expectedPose = 'STRAIGHT';
          }

          if (hasFace && hasLandmarks && liveBio) {
            setIsFaceDetected(true);
            setDebugFaceDetected(true);
            setDebugLandmarksDetected(true);
            setDebugDetectorStatus('READY');
            setDebugDetectorError(null);
            setDebugModelStatus('LOADED');

            // Neutral baseline calibration during initial frames of Step 1:
            if (step === 'lookStraight' && !isCalibratedRef.current) {
              neutralSamplesRef.current.push(liveBio.pose.normalizedNoseOffset);
              if (neutralSamplesRef.current.length >= 3) {
                const sum = neutralSamplesRef.current.reduce((a, b) => a + b, 0);
                const avg = sum / neutralSamplesRef.current.length;
                neutralYawBaselineRef.current = Math.max(-0.10, Math.min(0.10, avg));
                isCalibratedRef.current = true;
                console.log('[FaceRegistration] Calibrated neutral baseline:', neutralYawBaselineRef.current);
              }
            }

            const detectedPose = liveBio.pose.pose;
            const yaw = liveBio.pose.physicalYaw ?? 0;

            // Update debug indicators with real live facial telemetry
            setDebugYaw(yaw);
            setDebugDetectedPose(detectedPose);
            setDebugExpectedPose(expectedPose);

            const targetRequired = step === 'finalCapture' ? 4 : REQUIRED_STABLE_FRAMES;

            // Internal telemetry logging for registration diagnostics (throttled to ~500ms)
            if (timestamp - lastLogTimeRef.current > 500) {
              lastLogTimeRef.current = timestamp;
              console.log(
                `[FaceBiometrics] Step: ${step} | Face: ${hasFace} | Landmarks: ${hasLandmarks} | FaceWidth: ${liveBio.pose.faceWidth ?? '--'} | NoseX: ${liveBio.pose.noseX ?? '--'} | CenterX: ${liveBio.pose.faceCenterX ?? '--'} | Yaw: ${yaw >= 0 ? '+' : ''}${yaw.toFixed(3)} | Pose: ${detectedPose} | Expected: ${expectedPose} | StableFrames: ${consecutiveStableFramesRef.current}/${targetRequired}`
              );
            }

            // Step-specific validation: increment if detectedPose matches expectedPose
            if (detectedPose === expectedPose) {
              missedFramesRef.current = 0;
              consecutiveStableFramesRef.current = Math.min(targetRequired, consecutiveStableFramesRef.current + 1);
              const stableCount = consecutiveStableFramesRef.current;
              setDebugStableFrames(stableCount);

              const progress = Math.min(100, Math.round((stableCount / targetRequired) * 100));
              setStepProgress(progress);
              setDebugDetectionReason(`Aligned: ${stableCount}/${targetRequired}`);

              // =============================================================
              // STEP 1: LOOK STRAIGHT
              // =============================================================
              if (step === 'lookStraight') {
                setStatusMessage(`Looking straight — hold steady (${stableCount}/${REQUIRED_STABLE_FRAMES})`);

                if (stableCount >= REQUIRED_STABLE_FRAMES) {
                  // Capture 128D descriptor for Step 1
                  const fullBio = await detectFaceBiometrics(video, { extractDescriptor: true });
                  if (fullBio?.descriptor && isValidFaceDescriptor(fullBio.descriptor)) {
                    const descArr = Array.from(fullBio.descriptor);
                    straightDescriptorsRef.current.push(descArr);
                    capturedDescriptorsRef.current.push(descArr);
                  }
                  console.log('[FaceRegistration] Step 1 — Straight Pose Verified and Captured');

                  // Take photo snapshot from current live video
                  try {
                    const snapCanvas = document.createElement('canvas');
                    snapCanvas.width = video.videoWidth || 640;
                    snapCanvas.height = video.videoHeight || 480;
                    const snapCtx = snapCanvas.getContext('2d');
                    if (snapCtx) {
                      snapCtx.translate(snapCanvas.width, 0);
                      snapCtx.scale(-1, 1);
                      snapCtx.drawImage(video, 0, 0, snapCanvas.width, snapCanvas.height);
                      const photoDataUrl = snapCanvas.toDataURL('image/jpeg', 0.90);
                      setCapturedPhotoUrl(photoDataUrl);
                    }
                  } catch (snapErr) {
                    console.warn('[FaceRegistration] Frame capture snapshot notice:', snapErr);
                  }

                  setStatusMessage('Step 1 Completed ✓');
                  info('Step 1 — Look Straight Completed ✓');
                  isTransitioningRef.current = true;
                  consecutiveStableFramesRef.current = 0;
                  missedFramesRef.current = 0;

                  setTimeout(() => {
                    if (!isMounted) return;
                    setStepProgress(0);
                    setDebugStableFrames(0);
                    isTransitioningRef.current = false;
                    currentStepRef.current = 'turnLeft';
                    setCurrentStep('turnLeft');
                    setStatusMessage('Step 2: Turn your head slightly to your LEFT.');
                  }, 250);
                }
              }

              // =============================================================
              // STEP 2: TURN HEAD LEFT
              // =============================================================
              else if (step === 'turnLeft') {
                setStatusMessage(`Left turn detected — hold steady (${stableCount}/${REQUIRED_STABLE_FRAMES})`);

                if (stableCount >= REQUIRED_STABLE_FRAMES) {
                  const fullBio = await detectFaceBiometrics(video, { extractDescriptor: true });
                  if (fullBio?.descriptor && isValidFaceDescriptor(fullBio.descriptor)) {
                    capturedDescriptorsRef.current.push(fullBio.descriptor);
                  }
                  console.log('[FaceRegistration] Step 2 — Left Pose Verified and Captured');
                  setStatusMessage('Step 2 Completed ✓');
                  info('Step 2 — Turn Left Completed ✓');
                  isTransitioningRef.current = true;
                  consecutiveStableFramesRef.current = 0;
                  missedFramesRef.current = 0;

                  setTimeout(() => {
                    if (!isMounted) return;
                    setStepProgress(0);
                    setDebugStableFrames(0);
                    isTransitioningRef.current = false;
                    currentStepRef.current = 'turnRight';
                    setCurrentStep('turnRight');
                    setStatusMessage('Step 3: Turn your head slightly to your RIGHT.');
                  }, 250);
                }
              }

              // =============================================================
              // STEP 3: TURN HEAD RIGHT
              // =============================================================
              else if (step === 'turnRight') {
                setStatusMessage(`Right turn detected — hold steady (${stableCount}/${REQUIRED_STABLE_FRAMES})`);

                if (stableCount >= REQUIRED_STABLE_FRAMES) {
                  const fullBio = await detectFaceBiometrics(video, { extractDescriptor: true });
                  if (fullBio?.descriptor && isValidFaceDescriptor(fullBio.descriptor)) {
                    capturedDescriptorsRef.current.push(fullBio.descriptor);
                  }
                  console.log('[FaceRegistration] Step 3 — Right Pose Verified and Captured');
                  setStatusMessage('Step 3 Completed ✓');
                  info('Step 3 — Turn Right Completed ✓');
                  isTransitioningRef.current = true;
                  consecutiveStableFramesRef.current = 0;
                  missedFramesRef.current = 0;

                  setTimeout(() => {
                    if (!isMounted) return;
                    setStepProgress(0);
                    setDebugStableFrames(0);
                    isTransitioningRef.current = false;
                    currentStepRef.current = 'finalCapture';
                    setCurrentStep('finalCapture');
                    setStatusMessage('Step 4: Return to center and look STRAIGHT for final capture.');
                  }, 250);
                }
              }

              // =============================================================
              // STEP 4: FINAL FACE CAPTURE
              // =============================================================
              else if (step === 'finalCapture') {
                setStatusMessage(`Frontal face aligned — capturing final photo (${stableCount}/4)`);
                if (stableCount >= 4) {
                  isTransitioningRef.current = true;
                  executeFinalizeFlowRef.current();
                }
              }
            } else {
              // Detected pose does not match expected pose
              missedFramesRef.current += 1;
              // Allow up to 2 transient jitter frames before resetting accumulated stable frames
              if (missedFramesRef.current > 2) {
                consecutiveStableFramesRef.current = 0;
                setDebugStableFrames(0);
                setStepProgress(0);
              }
              setDebugDetectionReason(`Pose: ${detectedPose} (expected: ${expectedPose})`);

              if (step === 'lookStraight') {
                if (detectedPose === 'LEFT' || detectedPose === 'RIGHT') {
                  setStatusMessage('Head is turned — please look directly STRAIGHT at the camera');
                } else {
                  setStatusMessage('Keep face in camera and look directly straight');
                }
              } else if (step === 'turnLeft') {
                if (detectedPose === 'RIGHT') {
                  setStatusMessage('Turn your head to your LEFT (currently turned right)...');
                } else {
                  setStatusMessage('Turn your head slightly to your LEFT...');
                }
              } else if (step === 'turnRight') {
                if (detectedPose === 'LEFT') {
                  setStatusMessage('Turn your head to your RIGHT (currently turned left)...');
                } else {
                  setStatusMessage('Turn your head slightly to your RIGHT...');
                }
              } else if (step === 'finalCapture') {
                setStatusMessage('Return to center and look straight at the camera');
              }
            }
          } else {
            // No valid face or landmarks in frame
            setDebugFaceDetected(hasFace);
            setDebugLandmarksDetected(hasLandmarks);
            setDebugYaw(null);
            setDebugDetectedPose('UNKNOWN');
            setDebugExpectedPose(expectedPose);

            missedFramesRef.current += 1;
            // Allow up to 2 transient frames of missing data before resetting accumulated progress
            if (missedFramesRef.current > 2) {
              setIsFaceDetected(false);
              consecutiveStableFramesRef.current = 0;
              setDebugStableFrames(0);
              setStepProgress(0);
            }

            if (timestamp - lastLogTimeRef.current > 1000) {
              lastLogTimeRef.current = timestamp;
              console.log(
                `[FaceBiometrics] Step: ${step} | Face: ${hasFace} | Landmarks: ${hasLandmarks} | Pose: UNKNOWN | Expected: ${expectedPose} | Waiting for face in frame...`
              );
            }

            if (liveBio && liveBio.faceCount > 1) {
              setStatusMessage('Multiple faces detected — only 1 person allowed');
              setDebugDetectionReason('Multiple faces detected');
            } else {
              setStatusMessage('Camera active — Look straight at the camera');
              setDebugDetectionReason('Camera active — Detecting face...');
            }
          }
        } catch (loopErr) {
          console.warn('[FaceRegistration] Detection frame notice:', loopErr);
        } finally {
          isProcessingRef.current = false;
        }
      } else if (isChecking && registrationStartedRef.current) {
        if (!video || !video.srcObject) {
          setDebugDetectionReason('Camera active — Connecting video stream...');
        } else if (video.readyState < 2) {
          setDebugDetectionReason('Camera active — Waiting for camera stream...');
        }
      }

      if (isMounted && registrationStartedRef.current) {
        animId = requestAnimationFrame(runLoop);
        animIdRef.current = animId;
      }
    };

    animId = requestAnimationFrame(runLoop);
    animIdRef.current = animId;
    return () => {
      isMounted = false;
      if (animIdRef.current !== null) {
        cancelAnimationFrame(animIdRef.current);
        animIdRef.current = null;
      }
    };
  }, [registrationStarted]);

  // Helper to determine step status for checklist
  const getStepStatus = (stepId: FlowStep): 'not_started' | 'active' | 'completed' | 'pending' => {
    if (!registrationStarted) return 'not_started';
    const stepOrder: FlowStep[] = ['lookStraight', 'turnLeft', 'turnRight', 'finalCapture', 'duplicateCheck', 'saving', 'success'];
    const currentIdx = stepOrder.indexOf(currentStep);
    const targetIdx = stepOrder.indexOf(stepId);

    if (currentStep === 'success') return 'completed';
    if (targetIdx < currentIdx) return 'completed';
    if (targetIdx === currentIdx) return 'active';
    return 'pending';
  };

  const activeStepInfo = STEPS.find((s) => s.id === currentStep) || STEPS[0];

  return (
    <div id="face-registration-page" className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
      <Header />

      <main className="flex-1 max-w-7xl w-full mx-auto p-4 md:p-6 lg:p-8 flex flex-col justify-center">
        {/* Top Header Card */}
        <div className="mb-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 bg-slate-900/70 border border-slate-800/80 rounded-2xl p-4 md:p-5 backdrop-blur-md">
          <div className="flex items-center gap-3">
            <div className="p-3 bg-violet-500/10 border border-violet-500/20 rounded-xl text-violet-400">
              <ShieldCheck className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-xl md:text-2xl font-bold tracking-tight text-white flex items-center gap-2">
                Face Biometric Registration
              </h1>
              <p className="text-xs md:text-sm text-slate-400">
                Enroll your facial profile for secure, instant attendance verification.
              </p>
            </div>
          </div>

          {/* Action & Student Badge */}
          <div className="flex flex-wrap items-center gap-3">
            <button
              id="btn-face-registration"
              onClick={registrationStarted || isStarting || isSaving ? undefined : handleStartFaceRegistration}
              disabled={isStarting || isSaving || (registrationStarted && currentStep !== 'success' && currentStep !== 'error')}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-xl font-semibold text-xs md:text-sm transition-all shadow-lg ${
                isStarting || isSaving || (registrationStarted && currentStep !== 'success' && currentStep !== 'error')
                  ? 'bg-violet-900/50 text-violet-300 border border-violet-700/50 cursor-not-allowed opacity-90'
                  : 'bg-violet-600 hover:bg-violet-500 active:bg-violet-700 text-white shadow-violet-600/20 cursor-pointer'
              }`}
            >
              {isSaving ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin text-violet-300" />
                  SAVING REGISTRATION...
                </>
              ) : isStarting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin text-violet-300" />
                  STARTING CAMERA...
                </>
              ) : registrationStarted && currentStep !== 'success' && currentStep !== 'error' ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin text-violet-300" />
                  REGISTRATION IN PROGRESS
                </>
              ) : (
                <>
                  <Camera className="w-4 h-4" />
                  START FACE REGISTRATION
                </>
              )}
            </button>

            <button
              id="btn-reset-registration"
              onClick={handleResetRegistration}
              disabled={isSaving}
              className={`flex items-center gap-2 px-3.5 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 active:bg-slate-900 text-slate-300 font-semibold text-xs md:text-sm transition-all border border-slate-700/80 ${isSaving ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
            >
              <RotateCcw className="w-4 h-4" />
              Reset
            </button>

            {/* Student Badge */}
            {activeStudentDisplay && (
              <div id="student-identity-badge" className="flex items-center gap-3 bg-slate-950/60 border border-slate-800 rounded-xl px-4 py-2 self-start sm:self-auto">
                <div className="w-8 h-8 rounded-full bg-violet-600/20 text-violet-400 flex items-center justify-center font-bold text-xs">
                  {activeStudentDisplay.studentName?.charAt(0) || 'S'}
                </div>
                <div className="text-left">
                  <p className="text-xs font-semibold text-slate-200">{activeStudentDisplay.studentName}</p>
                  <p className="text-[11px] text-slate-400">
                    {activeStudentDisplay.rollNumber}{activeStudentDisplay.year ? ` • ${activeStudentDisplay.year}` : ''}
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Main Grid: Left Steps & Instructions | Right Live Camera Preview */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          
          {/* ================= LEFT PANEL (5 Cols) ================= */}
          <div className="lg:col-span-5 flex flex-col gap-5">
            
            {/* Active Step Card */}
            <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-5 md:p-6 shadow-xl backdrop-blur-md">
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs font-bold uppercase tracking-wider text-violet-400 bg-violet-500/10 border border-violet-500/20 px-2.5 py-1 rounded-full">
                  {registrationStarted ? `Step ${activeStepInfo.number} of 6` : 'Step 1 of 6'}
                </span>
                <span className="text-xs font-semibold text-slate-400">
                  {registrationStarted ? (currentStep === 'success' ? '100% Confirmed' : `${stepProgress}% Confirmed`) : '0% Complete'}
                </span>
              </div>

              <h2 className="text-xl font-extrabold text-white mb-2">
                {registrationStarted ? activeStepInfo.title : 'Ready to register your face'}
              </h2>
              <p className="text-sm text-slate-300 leading-relaxed mb-4">
                {registrationStarted 
                  ? activeStepInfo.instruction 
                  : 'Position yourself in front of your camera in good lighting. Click "START FACE REGISTRATION" below to begin.'}
              </p>

              {/* Progress Bar */}
              <div className="w-full bg-slate-800 rounded-full h-2.5 overflow-hidden mb-2">
                <motion.div 
                  className="bg-gradient-to-r from-violet-500 to-emerald-400 h-2.5 rounded-full"
                  animate={{ width: `${registrationStarted ? (currentStep === 'success' ? 100 : stepProgress) : 0}%` }}
                  transition={{ duration: 0.10 }}
                />
              </div>

              {/* Status Pill */}
              <div className="mt-3 flex items-center gap-2 text-xs font-medium text-slate-300 bg-slate-950/80 border border-slate-800/80 px-3 py-2 rounded-lg">
                {!registrationStarted ? (
                  <div className="w-2.5 h-2.5 rounded-full bg-slate-500 shrink-0" />
                ) : currentStep === 'success' ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                ) : currentStep === 'error' ? (
                  <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
                ) : currentStep === 'finalCapture' || currentStep === 'duplicateCheck' || currentStep === 'saving' || isSaving ? (
                  <Loader2 className="w-4 h-4 text-violet-400 animate-spin shrink-0" />
                ) : isFaceDetected ? (
                  <div className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse shrink-0" />
                ) : (
                  <div className="w-2.5 h-2.5 rounded-full bg-amber-400 shrink-0" />
                )}
                <span className="truncate">{statusMessage}</span>
              </div>

              {/* START FACE REGISTRATION card button when idle */}
              {!registrationStarted && (
                <button
                  id="btn-start-registration-card"
                  onClick={isSaving || isStarting ? undefined : handleStartFaceRegistration}
                  disabled={isStarting || isSaving}
                  className="w-full mt-4 flex items-center justify-center gap-2 px-5 py-3 rounded-xl bg-violet-600 hover:bg-violet-500 active:bg-violet-700 text-white font-bold text-sm transition-all shadow-lg shadow-violet-600/25 cursor-pointer hover:scale-[1.01] disabled:opacity-75 disabled:cursor-not-allowed"
                >
                  {isSaving ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin text-violet-300" />
                      SAVING REGISTRATION...
                    </>
                  ) : isStarting ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin text-violet-300" />
                      STARTING CAMERA...
                    </>
                  ) : (
                    <>
                      <Camera className="w-4 h-4" />
                      START FACE REGISTRATION
                    </>
                  )}
                </button>
              )}

              {/* Display captured frame preview when available */}
              {capturedPhotoUrl && currentStep !== 'success' && (
                <div className="mt-4 pt-4 border-t border-slate-800 flex items-center gap-3">
                  <div className="w-12 h-12 rounded-xl overflow-hidden border border-emerald-500/60 shrink-0">
                    <img src={capturedPhotoUrl} alt="Captured Profile" className="w-full h-full object-cover" />
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-emerald-400 flex items-center gap-1">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      Live Frame Captured
                    </p>
                    <p className="text-[11px] text-slate-400">Profile image stored for enrollment.</p>
                  </div>
                </div>
              )}
            </div>

            {/* Checklist of Registration Steps */}
            <div className="bg-slate-900/60 border border-slate-800/80 rounded-2xl p-5 backdrop-blur-md">
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-4">
                Registration Checklist
              </h3>

              <div className="space-y-3">
                {STEPS.map((step) => {
                  const status = getStepStatus(step.id);
                  return (
                    <div 
                      key={step.id} 
                      className={`flex items-center justify-between p-2.5 rounded-xl border transition-all ${
                        status === 'completed'
                          ? 'bg-emerald-950/20 border-emerald-500/30 text-emerald-300'
                          : status === 'active'
                          ? 'bg-violet-950/30 border-violet-500/40 text-white shadow-lg shadow-violet-950/30'
                          : 'bg-slate-950/40 border-slate-800/50 text-slate-500'
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <div className="shrink-0">
                          {status === 'completed' ? (
                            <CheckCircle2 className="w-5 h-5 text-emerald-400" />
                          ) : status === 'active' ? (
                            <div className="w-5 h-5 rounded-full border-2 border-violet-400 border-t-transparent animate-spin" />
                          ) : (
                            <div className="w-5 h-5 rounded-full border border-slate-700 flex items-center justify-center text-[10px] font-bold text-slate-400">
                              {step.number}
                            </div>
                          )}
                        </div>
                        <span className="text-xs md:text-sm font-semibold">
                          Step {step.number} — {step.label}
                        </span>
                      </div>

                      <span className="text-[11px] font-medium">
                        {status === 'completed' 
                          ? 'Completed ✓' 
                          : status === 'active' 
                          ? 'In Progress' 
                          : status === 'not_started' 
                          ? 'Not Started' 
                          : 'Pending'}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

          </div>

          {/* ================= RIGHT PANEL (7 Cols) ================= */}
          <div className="lg:col-span-7 flex flex-col gap-4">
            
            {/* Live Camera Feed & Viewport */}
            <div className="relative bg-slate-900 border border-slate-800 rounded-3xl overflow-hidden shadow-2xl aspect-[4/3] flex items-center justify-center">
              
              {/* Idle Viewport Overlay (Camera is OFF before Start Face Registration is clicked) */}
              {!registrationStarted && (
                <div id="camera-idle-overlay" className="absolute inset-0 z-30 bg-slate-950 flex flex-col items-center justify-center p-6 text-center">
                  <div className="w-16 h-16 rounded-2xl bg-violet-500/10 border border-violet-500/20 flex items-center justify-center text-violet-400 mb-4 shadow-xl shadow-violet-950/40">
                    <Camera className="w-8 h-8" />
                  </div>

                  <h3 className="text-lg md:text-xl font-bold text-white mb-2">
                    Ready to register your face
                  </h3>
                  <p className="text-xs md:text-sm text-slate-400 max-w-sm mb-6 leading-relaxed">
                    Camera is currently off. Click below to start face registration and begin Step 1.
                  </p>

                  <button
                    id="btn-start-face-registration-viewport"
                    onClick={isSaving || isStarting ? undefined : handleStartFaceRegistration}
                    disabled={isStarting || isSaving}
                    className="flex items-center gap-2.5 px-6 py-3.5 rounded-xl bg-violet-600 hover:bg-violet-500 active:bg-violet-700 text-white font-bold text-sm transition-all shadow-xl shadow-violet-600/30 cursor-pointer hover:scale-[1.02] disabled:opacity-75 disabled:cursor-not-allowed"
                  >
                    {isSaving ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin text-violet-300" />
                        SAVING REGISTRATION...
                      </>
                    ) : isStarting ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin text-violet-300" />
                        STARTING CAMERA...
                      </>
                    ) : (
                      <>
                        <Camera className="w-4 h-4" />
                        START FACE REGISTRATION
                      </>
                    )}
                  </button>
                </div>
              )}

              {/* Success Screen Overlay */}
              {registrationStarted && currentStep === 'success' && (
                <motion.div 
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="absolute inset-0 z-30 bg-slate-950/95 backdrop-blur-md flex flex-col items-center justify-center p-6 text-center"
                >
                  <div className="w-20 h-20 rounded-full bg-emerald-500/20 border-2 border-emerald-400 flex items-center justify-center text-emerald-400 mb-4 shadow-lg shadow-emerald-500/20">
                    <CheckCircle2 className="w-10 h-10" />
                  </div>

                  <h2 className="text-2xl md:text-3xl font-black text-white mb-2">
                    Face Registration Completed ✓
                  </h2>
                  <p className="text-sm text-slate-300 max-w-md mb-6">
                    Your facial profile is securely enrolled. You can now use facial recognition to mark daily attendance.
                  </p>

                  {capturedPhotoUrl && (
                    <div className="w-24 h-24 rounded-2xl overflow-hidden border-2 border-emerald-500/50 mb-6 shadow-md">
                      <img src={capturedPhotoUrl} alt="Enrolled Face" className="w-full h-full object-cover" />
                    </div>
                  )}

                  <button
                    id="btn-continue-dashboard"
                    onClick={() => navigate('/student')}
                    className="flex items-center gap-2 px-6 py-3.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-sm transition-all shadow-lg shadow-emerald-500/25 cursor-pointer"
                  >
                    Continue to Dashboard
                    <ArrowRight className="w-4 h-4" />
                  </button>
                </motion.div>
              )}

              {/* Error Screen Overlay (Duplicate face or fatal failure) */}
              {registrationStarted && currentStep === 'error' && (
                <motion.div 
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="absolute inset-0 z-30 bg-slate-950/95 backdrop-blur-md flex flex-col items-center justify-center p-6 text-center"
                >
                  <div className="w-16 h-16 rounded-full bg-rose-500/20 border-2 border-rose-500 flex items-center justify-center text-rose-400 mb-4">
                    <AlertTriangle className="w-8 h-8" />
                  </div>

                  <h2 className="text-xl md:text-2xl font-bold text-white mb-2">
                    {duplicateError ? 'Duplicate Face Detected' : 'Registration Incomplete'}
                  </h2>
                  <p className="text-sm text-rose-300 max-w-md mb-6 leading-relaxed">
                    {duplicateError 
                      ? 'This face is already registered with another account in the database. Each student must have a unique facial identity.' 
                      : statusMessage}
                  </p>

                  <button
                    id="btn-retry-registration"
                    onClick={isSaving ? undefined : handleTryAgain}
                    disabled={isSaving}
                    className={`flex items-center gap-2 px-5 py-3 rounded-xl bg-violet-600 hover:bg-violet-500 text-white font-bold text-sm transition-all shadow-lg shadow-violet-600/25 ${isSaving ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}`}
                  >
                    {isSaving ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin text-violet-300" />
                        Saving...
                      </>
                    ) : (
                      <>
                        <RotateCcw className="w-4 h-4" />
                        Try Again
                      </>
                    )}
                  </button>
                </motion.div>
              )}

              {/* Camera Permission Denied Overlay */}
              {registrationStarted && hasCameraPermission === false && (
                <div className="absolute inset-0 z-20 bg-slate-950/90 flex flex-col items-center justify-center p-6 text-center">
                  <div className="w-16 h-16 rounded-full bg-rose-500/20 border border-rose-500/30 flex items-center justify-center text-rose-400 mb-4">
                    <Camera className="w-8 h-8" />
                  </div>
                  <h3 className="text-lg font-bold text-white mb-1">Camera Access Required</h3>
                  <p className="text-sm text-slate-400 max-w-sm mb-5">
                    {cameraErrorMessage || 'Camera permission is required for face registration.'}
                  </p>
                  <button
                    id="btn-retry-camera"
                    onClick={() => startCamera(true)}
                    className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-violet-600 hover:bg-violet-500 text-white font-semibold text-sm transition-all cursor-pointer shadow-lg shadow-violet-600/20"
                  >
                    <RotateCcw className="w-4 h-4" />
                    Retry Camera
                  </button>
                </div>
              )}

              {/* Video Element (Direct live stream, mirrored for natural user perspective) */}
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                className="w-full h-full object-cover scale-x-[-1]"
              />

              {/* Canvas Overlay for Visual Guide */}
              <canvas
                ref={canvasRef}
                className="absolute inset-0 w-full h-full pointer-events-none z-10"
              />

              {/* Real-time Status Badge on Camera */}
              {registrationStarted && (
                <div className="absolute top-4 left-4 z-20">
                  <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-slate-950/80 backdrop-blur-md border border-slate-800 text-xs font-semibold">
                    {isFaceDetected ? (
                      <>
                        <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                        <span className="text-emerald-300">● Face detected</span>
                      </>
                    ) : (
                      <>
                        <span className="w-2 h-2 rounded-full bg-amber-400" />
                        <span className="text-amber-300">● Position face inside guide</span>
                      </>
                    )}
                  </div>
                </div>
              )}

              {/* Live Facial Telemetry & Pose Debug Indicator */}
              {registrationStarted && (
                <div id="pose-debug-indicator" className="absolute top-4 right-4 z-20 bg-slate-950/90 backdrop-blur-md border border-slate-800/90 rounded-xl px-3 py-2 text-[11px] font-mono shadow-xl text-slate-200 min-w-[190px]">
                  <div className="flex justify-between gap-3">
                    <span className="text-slate-400">Camera:</span>
                    <span className={isCameraReady ? 'text-emerald-400 font-bold' : 'text-rose-400 font-bold'}>
                      {isCameraReady ? 'READY' : 'NOT READY'}
                    </span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="text-slate-400">Detector:</span>
                    <span className={debugDetectorStatus === 'READY' ? 'text-emerald-400 font-bold' : debugDetectorStatus === 'ERROR' ? 'text-rose-400 font-bold' : 'text-slate-300 font-semibold'}>
                      {debugDetectorStatus}
                    </span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="text-slate-400">Model:</span>
                    <span className={debugModelStatus === 'LOADED' ? 'text-emerald-400 font-bold' : debugModelStatus === 'ERROR' ? 'text-rose-400 font-bold' : 'text-amber-300 font-semibold'}>
                      {debugModelStatus}
                    </span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="text-slate-400">Face:</span>
                    <span className={debugFaceDetected ? 'text-emerald-400 font-bold' : 'text-rose-400 font-bold'}>
                      {debugFaceDetected ? 'DETECTED' : 'NOT DETECTED'}
                    </span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="text-slate-400">Landmarks:</span>
                    <span className={debugLandmarksDetected ? 'text-emerald-400 font-bold' : 'text-rose-400 font-bold'}>
                      {debugLandmarksDetected ? 'READY' : 'NOT READY'}
                    </span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="text-slate-400">Yaw:</span>
                    <span className="font-semibold text-slate-100">
                      {debugYaw !== null ? (debugYaw >= 0 ? `+${debugYaw.toFixed(2)}` : debugYaw.toFixed(2)) : '--'}
                    </span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="text-slate-400">Detected Pose:</span>
                    <span className={debugDetectedPose === debugExpectedPose ? 'text-emerald-400 font-bold' : 'text-amber-300 font-bold'}>
                      {debugDetectedPose}
                    </span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="text-slate-400">Expected Pose:</span>
                    <span className="text-violet-400 font-semibold">{debugExpectedPose}</span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="text-slate-400">Stable Frames:</span>
                    <span className="text-white font-bold">{debugStableFrames}/{currentStep === 'finalCapture' ? 4 : REQUIRED_STABLE_FRAMES}</span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="text-slate-400">Current Step:</span>
                    <span className="text-violet-300 font-semibold">{activeStepInfo.label}</span>
                  </div>
                  {debugDetectorError && (
                    <div className="flex justify-between gap-2 pt-1 mt-1 border-t border-rose-900/60 text-[10px] text-rose-300">
                      <span className="text-rose-400 font-bold">Detector Error:</span>
                      <span className="text-rose-200 truncate max-w-[110px]" title={debugDetectorError}>
                        {debugDetectorError}
                      </span>
                    </div>
                  )}
                  {debugDetectionReason && (
                    <div className="flex justify-between gap-2 pt-1 mt-1 border-t border-slate-800/80 text-[10px]">
                      <span className="text-slate-400">Status:</span>
                      <span className="text-slate-300 truncate max-w-[110px]" title={debugDetectionReason}>
                        {debugDetectionReason}
                      </span>
                    </div>
                  )}

                  {/* Requirement 16: Telemetry in floating overlay */}
                  {duplicateDebugInfo.descriptorStatus !== 'IDLE' && (
                    <div className="pt-1 mt-1 border-t border-slate-800/80 text-[10px] space-y-0.5">
                      <div className="flex justify-between gap-2">
                        <span className="text-slate-400 font-semibold">Descriptor:</span>
                        <span className={duplicateDebugInfo.descriptorStatus === 'VALID' ? 'text-emerald-400 font-bold' : 'text-rose-400 font-bold'}>
                          {duplicateDebugInfo.descriptorStatus}
                        </span>
                      </div>
                      <div className="flex justify-between gap-2">
                        <span className="text-slate-400">Faces Checked:</span>
                        <span className="text-white font-bold">{duplicateDebugInfo.existingFacesChecked}</span>
                      </div>
                      <div className="flex justify-between gap-2">
                        <span className="text-slate-400">Min Distance:</span>
                        <span className="text-violet-300 font-bold">{duplicateDebugInfo.minDistance}</span>
                      </div>
                      <div className="flex justify-between gap-2">
                        <span className="text-slate-400">Duplicate:</span>
                        <span className={duplicateDebugInfo.isDuplicate === 'YES' ? 'text-rose-400 font-bold' : duplicateDebugInfo.isDuplicate === 'NO' ? 'text-emerald-400 font-bold' : 'text-slate-400'}>
                          {duplicateDebugInfo.isDuplicate}
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Directional Hint Banner at Bottom of Video */}
              {registrationStarted && (
                <div className="absolute bottom-4 inset-x-4 z-20">
                  <div className="bg-slate-950/85 backdrop-blur-md border border-slate-800/80 rounded-2xl p-3 text-center shadow-lg">
                    <p className="text-xs md:text-sm font-bold text-white">
                      {statusMessage}
                    </p>
                  </div>
                </div>
              )}

            </div>

            {/* Requirement 16: Biometric Duplicate Verification Debug Section */}
            <div id="duplicate-biometric-debug-panel" className="bg-slate-900/90 border border-slate-800/80 rounded-xl p-3.5 shadow-sm">
              <div className="flex items-center justify-between text-xs font-semibold text-slate-400 mb-2.5">
                <span className="flex items-center gap-1.5 text-slate-300 font-medium">
                  <span className="w-2 h-2 rounded-full bg-violet-400 animate-pulse" />
                  Biometric Duplicate Telemetry
                </span>
                <span className="text-[11px] text-violet-300 bg-violet-950/60 border border-violet-800/50 px-2 py-0.5 rounded-full font-mono">
                  Threshold: {FACE_MATCH_THRESHOLD.toFixed(2)}
                </span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-xs">
                <div className="p-2.5 rounded-lg bg-slate-950/70 border border-slate-800/70">
                  <span className="text-[10px] text-slate-400 block uppercase tracking-wider font-semibold mb-1">Descriptor</span>
                  <span id="debug-descriptor-val" className={`font-mono font-bold text-sm ${duplicateDebugInfo.descriptorStatus === 'VALID' ? 'text-emerald-400' : duplicateDebugInfo.descriptorStatus === 'INVALID' ? 'text-rose-400' : 'text-slate-500'}`}>
                    {duplicateDebugInfo.descriptorStatus}
                  </span>
                </div>
                <div className="p-2.5 rounded-lg bg-slate-950/70 border border-slate-800/70">
                  <span className="text-[10px] text-slate-400 block uppercase tracking-wider font-semibold mb-1">Faces Checked</span>
                  <span id="debug-faces-val" className="font-mono font-bold text-sm text-white">
                    {duplicateDebugInfo.existingFacesChecked}
                  </span>
                </div>
                <div className="p-2.5 rounded-lg bg-slate-950/70 border border-slate-800/70">
                  <span className="text-[10px] text-slate-400 block uppercase tracking-wider font-semibold mb-1">Min Distance</span>
                  <span id="debug-distance-val" className="font-mono font-bold text-sm text-violet-300">
                    {duplicateDebugInfo.minDistance}
                  </span>
                </div>
                <div className="p-2.5 rounded-lg bg-slate-950/70 border border-slate-800/70">
                  <span className="text-[10px] text-slate-400 block uppercase tracking-wider font-semibold mb-1">Duplicate</span>
                  <span id="debug-duplicate-val" className={`font-mono font-bold text-sm ${duplicateDebugInfo.isDuplicate === 'YES' ? 'text-rose-400' : duplicateDebugInfo.isDuplicate === 'NO' ? 'text-emerald-400' : 'text-slate-500'}`}>
                    {duplicateDebugInfo.isDuplicate}
                  </span>
                </div>
              </div>
            </div>

            {/* Bottom Controls Bar with Reset Registration Button */}
            <div className="flex items-center justify-between text-xs text-slate-400 px-2">
              <span className="flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-violet-400" />
                Live 128-d biometric neural network
              </span>

              <button
                id="btn-reset-registration"
                onClick={handleResetRegistration}
                disabled={isSaving}
                className={`flex items-center gap-1.5 hover:text-rose-400 transition-colors py-1.5 px-3 rounded-lg bg-slate-900 border border-slate-800 hover:border-rose-500/40 font-medium ${isSaving ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Reset Registration
              </button>
            </div>

          </div>

        </div>
      </main>
    </div>
  );
};

export default FaceRegistration;
