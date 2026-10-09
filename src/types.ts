export interface UserProfile {
  uid: string;
  name: string;
  email: string;
  role: 'student' | 'staff' | 'admin';
  createdAt: string;
  faceResetRequested?: boolean;
}

export interface StudentProfile {
  studentId: string; // matches uid
  uid: string;
  studentName: string;
  rollNumber: string;
  department: string;
  year: string;
  assignedClass?: string;
  email: string;
  faceRegistered: boolean;
  faceEmbedding?: number[] | null; // Master average feature numbers
  faceEmbeddings?: Array<{ vector: number[] }> | number[][] | null; // Multi-angle individual descriptors
  photoURL?: string;
  attendancePercentage: number;
  faceResetRequested?: boolean;
  faceResetRequestedAt?: string;
  qrId?: string; // Permanent opaque QR identifier
  qrCreatedAt?: string;
}

export interface StaffProfile {
  staffId: string;
  uid: string;
  fullName: string;
  staffName?: string; // fallback
  department: string;
  assignedClass: string;
  year?: string;
  academicYear?: string;
  email: string;
  role?: string;
  createdAt?: string;
}

export interface AttendanceRecord {
  attendanceId: string; // formatted like "uid_YYYY-MM-DD"
  studentId: string;
  date: string; // "YYYY-MM-DD"
  entryTime?: string; // "HH:MM:SS"
  exitTime?: string; // "HH:MM:SS"
  entryStatus: 'Present' | 'Absent' | 'Late' | 'Pending';
  exitStatus: 'Present' | 'Absent' | 'Early' | 'Pending';
  overallStatus: 'Present' | 'Half Day' | 'Absent' | 'Needs Staff Review';
  matchScore?: number;
  distanceValue?: number;
  verificationTimestamp?: string;
  attendanceMethod?: string;
  verificationResult?: string;
}

export interface PeriodInfo {
  periodNumber: number; // 1 | 2 | 3 | 4 | 5
  name: string; // "Period 1"
  startTime: string; // "09:00"
  endTime: string; // "09:55"
  formattedRange: string; // "9:00 AM - 9:55 AM"
  isLunch?: boolean;
}

export type TimetableState = 'before_college' | 'in_period' | 'lunch_break' | 'after_college';

export interface TimetableStatusResult {
  state: TimetableState;
  period: PeriodInfo | null;
  message: string;
  nextPeriod?: PeriodInfo | null;
  currentTimeString: string;
}

export interface PeriodAttendanceRecord {
  recordId: string; // formatted deterministic ID: `${date}_${studentId}_P${period}`
  studentId: string;
  studentName: string;
  rollNumber: string;
  department?: string;
  assignedClass?: string;
  date: string; // "YYYY-MM-DD"
  period: number; // 1, 2, 3, 4, 5
  periodName: string; // "Period 1"
  periodTimeRange: string; // "9:00 AM - 9:55 AM"
  subject?: string;
  staffId: string;
  staffName: string;
  timestamp: string; // ISO string
  scanTime: string; // Formatted 12-hr time "10:08 AM"
  status: 'PRESENT';
  attendanceMethod: 'QR';
}

export interface Department {
  id: string;
  name: string;
}

export interface SystemSettings {
  id: string;
  entryStartTime: string; // "09:00"
  entryEndTime: string;   // "09:30"
  exitStartTime: string;  // "15:00"
  exitEndTime: string;    // "15:15"
}
