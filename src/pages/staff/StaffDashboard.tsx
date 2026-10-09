import React, { useEffect, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import Header from '../../components/Header';
import { formatTime12hr, getLocalDateString } from '../../utils/faceUtils';
import { collection, getDocs, doc, updateDoc, setDoc, query, where, getDoc } from 'firebase/firestore';
import { db } from '../../firebase/firebase';
import { StudentProfile, AttendanceRecord, StaffProfile, PeriodAttendanceRecord } from '../../types';
import { getCurrentTimetableStatus, COLLEGE_TIMETABLE } from '../../utils/timetableUtils';
import { decodeStudentQrPayload } from '../../utils/qrUtils';
import QRScanner from '../../components/QRScanner';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Search, GraduationCap, Calendar, Download, FileSpreadsheet, 
  FileText, Users, CheckCircle, XCircle, AlertCircle, RefreshCw, BarChart2, CheckSquare, Eye,
  Lock, User, Mail, LogOut, CheckSquare as CheckIcon, ClipboardList, QrCode, ShieldCheck, Layers, Clock, Camera
} from 'lucide-react';
import * as XLSX from 'xlsx';
import { jsPDF } from 'jspdf';
import { updatePassword, updateProfile as authUpdateProfile } from 'firebase/auth';
import { auth } from '../../firebase/firebase';
import { getStudentAssignedClass, getDeptName, ACADEMIC_DEPARTMENTS, getClassFromDeptAndYear } from '../../utils/academicData';

const StaffDashboard: React.FC = () => {
  const { staffProfile, userProfile, refreshProfile, logout } = useAuth();
  const { success, error, info, warn } = useToast();

  const [activeTab, setActiveTab] = useState<'students' | 'daily' | 'monthly' | 'qr_attendance' | 'profile'>('students');
  const [loading, setLoading] = useState(true);

  // Loaded database lists
  const [students, setStudents] = useState<StudentProfile[]>([]);
  const [attendance, setAttendance] = useState<AttendanceRecord[]>([]);

  // Automatic assigned class lock
  const staffDepartment = staffProfile?.department || 'CS';
  const assignedClass = staffProfile?.assignedClass || getClassFromDeptAndYear(staffDepartment, staffProfile?.year || '1st Year');

  // Selection Inputs (Date remains configurable)
  const [targetDate, setTargetDate] = useState(getLocalDateString());

  // Search filter
  const [searchQuery, setSearchQuery] = useState('');

  // QR Code Modal State
  const [showQRModal, setShowQRModal] = useState(false);

  // Report Type (Daily, Weekly, Monthly)
  const [reportType, setReportType] = useState<'daily' | 'weekly' | 'monthly'>('daily');

  // Edit Profile States
  const [editName, setEditName] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [isSavingProfile, setIsSavingProfile] = useState(false);
  const [isChangingPassword, setIsChangingPassword] = useState(false);

  // QR Period Attendance States
  const [periodAttendanceList, setPeriodAttendanceList] = useState<PeriodAttendanceRecord[]>([]);
  const [isQrScannerOpen, setIsQrScannerOpen] = useState(false);
  const [isScanningProcessing, setIsScanningProcessing] = useState(false);
  const [currentTime, setCurrentTime] = useState<Date>(new Date());
  const [simulatedPeriod, setSimulatedPeriod] = useState<number | null>(null);
  const [selectedPeriodTab, setSelectedPeriodTab] = useState<number | 'all'>('all');
  const [scanSubject, setScanSubject] = useState(assignedClass ? `${assignedClass} Lecture` : 'Core Subject');
  const [lastScanResult, setLastScanResult] = useState<{
    type: 'success' | 'duplicate' | 'error' | 'warning';
    title: string;
    studentName?: string;
    rollNumber?: string;
    period?: number;
    time?: string;
    message: string;
  } | null>(null);

  // Live real-time clock ticker
  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTime(new Date());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      // 1. Fetch Students
      const studentsSnap = await getDocs(collection(db, 'students'));
      const studentList: StudentProfile[] = [];
      studentsSnap.forEach((docSnap) => {
        studentList.push(docSnap.data() as StudentProfile);
      });
      setStudents(studentList);

      // 2. Fetch Attendance
      const attendanceSnap = await getDocs(collection(db, 'attendance'));
      const attendanceList: AttendanceRecord[] = [];
      attendanceSnap.forEach((docSnap) => {
        attendanceList.push(docSnap.data() as AttendanceRecord);
      });
      setAttendance(attendanceList);

      // 3. Fetch Period Attendance
      const periodSnap = await getDocs(
        query(collection(db, 'period_attendance'), where('date', '==', targetDate))
      );
      const pList: PeriodAttendanceRecord[] = [];
      periodSnap.forEach((docSnap) => {
        pList.push(docSnap.data() as PeriodAttendanceRecord);
      });
      setPeriodAttendanceList(pList);
    } catch (err: any) {
      console.error(err);
      error("Failed to sync records from databases.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [targetDate]);

  // QR ATTENDANCE VALIDATION HANDLER
  const handleScanQr = async (scannedText: string) => {
    if (isScanningProcessing) return;
    setIsScanningProcessing(true);

    try {
      // Step 1: Read QR ID
      const decoded = decodeStudentQrPayload(scannedText);
      if (!decoded || !decoded.qrId) {
        setLastScanResult({
          type: 'error',
          title: 'Invalid QR Code',
          message: 'The scanned code is not a recognized Student Permanent Attendance QR.',
        });
        error('Invalid QR Code. Please scan official student QR.');
        return;
      }

      // Step 2: Determine current period from timetable
      const timetableStatus = getCurrentTimetableStatus(currentTime, simulatedPeriod);
      if (timetableStatus.state === 'before_college') {
        setLastScanResult({
          type: 'error',
          title: 'Attendance Closed',
          message: 'Attendance has not started.',
        });
        warn('Attendance has not started.');
        return;
      }
      if (timetableStatus.state === 'after_college') {
        setLastScanResult({
          type: 'error',
          title: 'Attendance Closed',
          message: "Today's Period Attendance is Closed.",
        });
        warn("Today's Period Attendance is Closed.");
        return;
      }
      if (timetableStatus.state === 'lunch_break') {
        setLastScanResult({
          type: 'error',
          title: 'Lunch Break Active',
          message: 'Lunch Break — Period Attendance is Closed.',
        });
        warn('Lunch Break — Period Attendance is Closed.');
        return;
      }

      const currentPeriod = timetableStatus.period;
      if (!currentPeriod) {
        error('Could not determine active period.');
        return;
      }

      // Step 3: Find student associated with that QR ID
      let student: StudentProfile | null = null;
      if (decoded.uid) {
        const sSnap = await getDoc(doc(db, 'students', decoded.uid));
        if (sSnap.exists()) {
          const sData = sSnap.data() as StudentProfile;
          if (sData.qrId === decoded.qrId) {
            student = sData;
          }
        }
      }

      if (!student) {
        const q = query(collection(db, 'students'), where('qrId', '==', decoded.qrId));
        const qSnap = await getDocs(q);
        if (!qSnap.empty) {
          student = qSnap.docs[0].data() as StudentProfile;
        }
      }

      if (!student) {
        setLastScanResult({
          type: 'error',
          title: 'Student Not Found',
          message: 'No registered student matches this QR token. Student must complete face registration first.',
        });
        error('Unrecognized Student QR.');
        return;
      }

      if (!student.faceRegistered) {
        setLastScanResult({
          type: 'error',
          title: 'Registration Incomplete',
          studentName: student.studentName,
          rollNumber: student.rollNumber,
          message: `${student.studentName} has not completed Face Registration. Biometric profile is required.`,
        });
        error('Student has not completed face registration.');
        return;
      }

      // Step 4: Check today's date & College Gate Face Entry
      const todayDocId = `${student.uid}_${targetDate}`;
      const gateAttendanceSnap = await getDoc(doc(db, 'attendance', todayDocId));
      const gateData = gateAttendanceSnap.exists() ? (gateAttendanceSnap.data() as AttendanceRecord) : null;
      const hasGateEntry = gateData && (gateData.entryStatus === 'Present' || !!gateData.entryTime);

      if (!hasGateEntry) {
        setLastScanResult({
          type: 'warning',
          title: 'College Face Entry Required',
          studentName: student.studentName,
          rollNumber: student.rollNumber,
          message: `${student.studentName} has not completed facial recognition entrance verification today (${targetDate}). Period attendance cannot be marked before college gate entry.`,
        });
        warn(`College Gate Entry Required for ${student.studentName}`);
        return;
      }

      // Step 5: Check whether student already has attendance for that period (Duplicate Prevention)
      const recordId = `${targetDate}_${student.uid}_P${currentPeriod.periodNumber}`;
      const periodDocRef = doc(db, 'period_attendance', recordId);
      const existingPeriodSnap = await getDoc(periodDocRef);

      if (existingPeriodSnap.exists()) {
        const prev = existingPeriodSnap.data() as PeriodAttendanceRecord;
        setLastScanResult({
          type: 'duplicate',
          title: 'Attendance Already Marked',
          studentName: student.studentName,
          rollNumber: student.rollNumber,
          period: currentPeriod.periodNumber,
          time: prev.scanTime,
          message: `${student.studentName} (${student.rollNumber}) is already marked PRESENT for Period ${currentPeriod.periodNumber} at ${prev.scanTime}.`,
        });
        info(`Attendance Already Marked: ${student.studentName} (Period ${currentPeriod.periodNumber})`);
        return;
      }

      // Step 6: Record period attendance
      const nowTimeStr = new Date().toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
      });

      const newRecord: PeriodAttendanceRecord = {
        recordId,
        studentId: student.uid,
        studentName: student.studentName,
        rollNumber: student.rollNumber,
        department: student.department || '',
        assignedClass: getStudentAssignedClass(student),
        date: targetDate,
        period: currentPeriod.periodNumber,
        periodName: currentPeriod.name,
        periodTimeRange: currentPeriod.formattedRange,
        subject: scanSubject || assignedClass || 'Lecture Session',
        staffId: staffProfile?.uid || auth.currentUser?.uid || 'staff',
        staffName: staffProfile?.fullName || staffProfile?.staffName || userProfile?.name || 'Staff Faculty',
        timestamp: new Date().toISOString(),
        scanTime: nowTimeStr,
        status: 'PRESENT',
        attendanceMethod: 'QR',
      };

      await setDoc(periodDocRef, newRecord);

      setPeriodAttendanceList((prev) => [newRecord, ...prev.filter((r) => r.recordId !== recordId)]);

      setLastScanResult({
        type: 'success',
        title: 'Attendance Recorded',
        studentName: student.studentName,
        rollNumber: student.rollNumber,
        period: currentPeriod.periodNumber,
        time: nowTimeStr,
        message: `Period ${currentPeriod.periodNumber} attendance successfully marked PRESENT.`,
      });

      success(`✓ PRESENT: ${student.studentName} (Period ${currentPeriod.periodNumber})`);
    } catch (scanErr: any) {
      console.error('Scan validation error:', scanErr);
      setLastScanResult({
        type: 'error',
        title: 'Scan Error',
        message: scanErr.message || 'Failed to record attendance.',
      });
      error('Failed to validate attendance record.');
    } finally {
      setIsScanningProcessing(false);
    }
  };

  // Sync profile fields when staffProfile loads
  useEffect(() => {
    if (staffProfile) {
      setEditName(staffProfile.fullName || staffProfile.staffName || userProfile?.name || '');
    } else if (userProfile) {
      setEditName(userProfile.name || '');
    }
  }, [staffProfile, userProfile]);

  // Filter students AUTOMATICALLY based on assignedClass
  const getFilteredStudentsList = () => {
    return students.filter((s) => {
      const matchesSearch = s.studentName.toLowerCase().includes(searchQuery.toLowerCase()) || 
                            s.rollNumber.toLowerCase().includes(searchQuery.toLowerCase());
      const sClass = getStudentAssignedClass(s);
      return matchesSearch && sClass === assignedClass;
    });
  };

  const filteredStudents = getFilteredStudentsList();

  // Daily attendance report automatically filtered by assignedClass
  const getDailyAttendanceReport = () => {
    return students
      .filter((s) => getStudentAssignedClass(s) === assignedClass)
      .map((student) => {
        const log = attendance.find((a) => a.studentId === student.uid && a.date === targetDate);
        return {
          student,
          log: log || null
        };
      })
      .filter((entry) => {
        if (!searchQuery) return true;
        return entry.student.studentName.toLowerCase().includes(searchQuery.toLowerCase()) ||
               entry.student.rollNumber.toLowerCase().includes(searchQuery.toLowerCase());
      });
  };

  const dailyAttendanceReport = getDailyAttendanceReport();

  // Calculate stats based on assigned class
  const totalInScope = dailyAttendanceReport.length;
  const presentToday = dailyAttendanceReport.filter(r => r.log?.overallStatus === 'Present').length;
  const halfDayToday = dailyAttendanceReport.filter(r => r.log?.overallStatus === 'Half Day').length;
  const needsReviewToday = dailyAttendanceReport.filter(r => r.log?.overallStatus === 'Needs Staff Review').length;
  const absentToday = totalInScope - (presentToday + halfDayToday + needsReviewToday);

  // EXPORT TO EXCEL
  const handleExportExcel = () => {
    try {
      const targetStudents = students.filter((s) => getStudentAssignedClass(s) === assignedClass);

      let exportData = [];

      if (reportType === 'daily') {
        exportData = targetStudents.map((student) => {
          const log = attendance.find((a) => a.studentId === student.uid && a.date === targetDate);
          return {
            'Student Name': student.studentName,
            'Roll Number': student.rollNumber,
            'Assigned Class': assignedClass,
            'Department': getDeptName(student.department),
            'Email': student.email,
            'Date': targetDate,
            'Entry Time': log?.entryTime ? formatTime12hr(log.entryTime) : 'Absent',
            'Exit Time': log?.exitTime ? formatTime12hr(log.exitTime) : 'Absent',
            'Overall Status': log?.overallStatus || 'Absent'
          };
        });
      } else {
        const daysCount = reportType === 'weekly' ? 7 : 30;
        const today = new Date();
        const dateList: string[] = [];
        for (let i = 0; i < daysCount; i++) {
          const d = new Date();
          d.setDate(today.getDate() - i);
          dateList.push(d.toISOString().split('T')[0]);
        }

        exportData = targetStudents.map((student) => {
          const studentLogs = attendance.filter((a) => a.studentId === student.uid && dateList.includes(a.date));
          const presentDays = studentLogs.filter(l => l.overallStatus === 'Present' || l.overallStatus === 'Half Day').length;
          const absentDays = daysCount - presentDays;
          const percentage = daysCount > 0 ? Math.round((presentDays / daysCount) * 100) : 0;

          return {
            'Student Name': student.studentName,
            'Roll Number': student.rollNumber,
            'Assigned Class': assignedClass,
            'Department': getDeptName(student.department),
            'Email': student.email,
            'Days Analyzed': daysCount,
            'Present Days': presentDays,
            'Absent Days': absentDays,
            'Attendance Rate': `${percentage}%`
          };
        });
      }

      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.json_to_sheet(exportData);
      XLSX.utils.book_append_sheet(wb, ws, `Attendance_${reportType}`);
      XLSX.writeFile(wb, `${assignedClass}_Attendance_${reportType}_${targetDate}.xlsx`);
      success(`Classroom attendance exported to Excel (${reportType})!`);
    } catch (err: any) {
      console.error(err);
      error("Excel generation failed.");
    }
  };

  // EXPORT TO PDF
  const handleExportPDF = () => {
    try {
      const pdf = new jsPDF();
      pdf.setFont('Helvetica', 'normal');
      
      // Header Banner
      pdf.setFillColor(109, 40, 217); // Violet-700
      pdf.rect(0, 0, 210, 40, 'F');
      
      pdf.setTextColor(255, 255, 255);
      pdf.setFontSize(18);
      pdf.setFont('Helvetica', 'bold');
      pdf.text(`CLASS ATTENDANCE REPORT: ${assignedClass}`, 15, 18);
      
      pdf.setFontSize(10);
      pdf.setFont('Helvetica', 'normal');
      pdf.text(`Official Faculty Report  |  Scope: ${assignedClass}  |  Generated: ${new Date().toLocaleDateString()}`, 15, 28);

      // Metadata Info Box
      pdf.setTextColor(40, 40, 40);
      pdf.setFontSize(11);
      pdf.setFont('Helvetica', 'bold');
      pdf.text(`Period: ${reportType.toUpperCase()}`, 15, 55);
      pdf.text(`Assigned Class: ${assignedClass}`, 15, 62);
      pdf.text(`Department: ${getDeptName(staffDepartment)}`, 15, 69);

      const targetStudents = students.filter((s) => getStudentAssignedClass(s) === assignedClass);

      pdf.setDrawColor(200, 200, 200);
      pdf.line(15, 75, 195, 75);

      if (reportType === 'daily') {
        pdf.setFont('Helvetica', 'bold');
        pdf.text('Roll No', 15, 81);
        pdf.text('Student Name', 45, 81);
        pdf.text('Entry', 105, 81);
        pdf.text('Exit', 140, 81);
        pdf.text('Status', 170, 81);
        pdf.line(15, 85, 195, 85);

        pdf.setFont('Helvetica', 'normal');
        let currentY = 91;

        targetStudents.forEach((student) => {
          if (currentY > 275) {
            pdf.addPage();
            currentY = 20;
          }
          const log = attendance.find((a) => a.studentId === student.uid && a.date === targetDate);
          
          pdf.text(student.rollNumber, 15, currentY);
          pdf.text(student.studentName.slice(0, 24), 45, currentY);
          pdf.text(log?.entryTime ? formatTime12hr(log.entryTime) : 'Absent', 105, currentY);
          pdf.text(log?.exitTime ? formatTime12hr(log.exitTime) : 'Absent', 140, currentY);
          pdf.text(log?.overallStatus || 'Absent', 170, currentY);
          
          pdf.line(15, currentY + 4, 195, currentY + 4);
          currentY += 10;
        });
      } else {
        pdf.setFont('Helvetica', 'bold');
        pdf.text('Roll No', 15, 81);
        pdf.text('Student Name', 45, 81);
        pdf.text('Days Analyzed', 105, 81);
        pdf.text('Present Days', 140, 81);
        pdf.text('Rate (%)', 170, 81);
        pdf.line(15, 85, 195, 85);

        pdf.setFont('Helvetica', 'normal');
        let currentY = 91;

        const daysCount = reportType === 'weekly' ? 7 : 30;
        const today = new Date();
        const dateList: string[] = [];
        for (let i = 0; i < daysCount; i++) {
          const d = new Date();
          d.setDate(today.getDate() - i);
          dateList.push(d.toISOString().split('T')[0]);
        }

        targetStudents.forEach((student) => {
          if (currentY > 275) {
            pdf.addPage();
            currentY = 20;
          }
          const studentLogs = attendance.filter((a) => a.studentId === student.uid && dateList.includes(a.date));
          const presentDays = studentLogs.filter(l => l.overallStatus === 'Present' || l.overallStatus === 'Half Day').length;
          const percentage = daysCount > 0 ? Math.round((presentDays / daysCount) * 100) : 0;

          pdf.text(student.rollNumber, 15, currentY);
          pdf.text(student.studentName.slice(0, 24), 45, currentY);
          pdf.text(String(daysCount), 105, currentY);
          pdf.text(String(presentDays), 140, currentY);
          pdf.text(`${percentage}%`, 170, currentY);
          
          pdf.line(15, currentY + 4, 195, currentY + 4);
          currentY += 10;
        });
      }

      pdf.save(`${assignedClass}_Attendance_Report_${targetDate}.pdf`);
      success(`Attendance report exported to PDF!`);
    } catch (err: any) {
      console.error(err);
      error("PDF generation failed.");
    }
  };

  // Staff action: Override Status
  const handleReviewStatus = async (recordId: string, status: 'Present' | 'Half Day' | 'Absent') => {
    try {
      const recordRef = doc(db, 'attendance', recordId);
      await updateDoc(recordRef, {
        overallStatus: status
      });
      success("Attendance status updated successfully!");
      await loadData();
    } catch (err: any) {
      console.error(err);
      error("Database update error.");
    }
  };

  const getStatusColorClass = (status: string) => {
    switch (status) {
      case 'Present': return 'text-emerald-500 bg-emerald-500/10 border-emerald-500/20';
      case 'Half Day': return 'text-amber-500 bg-amber-500/10 border-amber-500/20';
      case 'Needs Staff Review': return 'text-blue-500 bg-blue-500/10 border-blue-500/20';
      default: return 'text-rose-500 bg-rose-500/10 border-rose-500/20';
    }
  };

  // Profile Save
  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editName.trim()) {
      error("Name cannot be empty.");
      return;
    }

    setIsSavingProfile(true);
    try {
      const uid = auth.currentUser?.uid;
      if (!uid) throw new Error("No authenticated user session.");

      const staffRef = doc(db, 'staffs', uid);
      const staffRefLegacy = doc(db, 'staff', uid);
      const userRef = doc(db, 'users', uid);

      await updateDoc(staffRef, {
        fullName: editName,
        staffName: editName
      }).catch(() => {});

      await updateDoc(staffRefLegacy, {
        fullName: editName,
        staffName: editName
      }).catch(() => {});

      await updateDoc(userRef, {
        name: editName
      });

      if (auth.currentUser) {
        await authUpdateProfile(auth.currentUser, {
          displayName: editName
        }).catch((e) => console.warn("Staff authUpdateProfile notice:", e));
      }

      await refreshProfile();
      success("Staff profile updated successfully!");
    } catch (err: any) {
      console.error(err);
      error(err.message || "Failed to update profile.");
    } finally {
      setIsSavingProfile(false);
    }
  };

  // Password Change
  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPassword || !confirmNewPassword) {
      error("Please fill in both password fields.");
      return;
    }

    if (newPassword !== confirmNewPassword) {
      error("Passwords do not match.");
      return;
    }

    if (newPassword.length < 6) {
      error("Password must be at least 6 characters.");
      return;
    }

    setIsChangingPassword(true);
    try {
      if (auth.currentUser) {
        await updatePassword(auth.currentUser, newPassword);
        setNewPassword('');
        setConfirmNewPassword('');
        success("Password updated successfully!");
      } else {
        throw new Error("No active session.");
      }
    } catch (err: any) {
      console.error(err);
      error(err.message || "Failed to update password. You may need to re-authenticate.");
    } finally {
      setIsChangingPassword(false);
    }
  };

  const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(
    JSON.stringify({ classId: assignedClass, date: targetDate, timestamp: Date.now() })
  )}&size=240x240`;

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-100 flex flex-col transition-colors duration-300">
      <Header title="Staff Command Center" />

      {/* Stats Cards Band */}
      <section className="max-w-7xl w-full mx-auto px-4 md:px-6 mt-6 grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-5 rounded-3xl shadow-md flex items-center gap-4">
          <div className="p-3 bg-violet-500/10 text-violet-500 rounded-2xl border border-violet-500/20 shrink-0">
            <Users className="w-6 h-6" />
          </div>
          <div>
            <p className="text-[10px] uppercase font-bold tracking-wider text-slate-400 font-mono">
              Class Students ({assignedClass})
            </p>
            <h4 className="text-2xl font-bold mt-0.5">{loading ? '--' : totalInScope}</h4>
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-5 rounded-3xl shadow-md flex items-center gap-4">
          <div className="p-3 bg-emerald-500/10 text-emerald-500 rounded-2xl border border-emerald-500/20 shrink-0">
            <CheckSquare className="w-6 h-6" />
          </div>
          <div>
            <p className="text-[10px] uppercase font-bold tracking-wider text-slate-400 font-mono">Present Today</p>
            <h4 className="text-2xl font-bold mt-0.5">{loading ? '--' : presentToday}</h4>
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-5 rounded-3xl shadow-md flex items-center gap-4">
          <div className="p-3 bg-rose-500/10 text-rose-500 rounded-2xl border border-rose-500/20 shrink-0">
            <XCircle className="w-6 h-6" />
          </div>
          <div>
            <p className="text-[10px] uppercase font-bold tracking-wider text-slate-400 font-mono">Absent List</p>
            <h4 className="text-2xl font-bold mt-0.5">{loading ? '--' : absentToday}</h4>
          </div>
        </div>
      </section>

      {/* Main Console Layout */}
      <div className="max-w-7xl w-full mx-auto p-4 md:p-6 grid grid-cols-1 lg:grid-cols-12 gap-6 flex-1">
        
        {/* Navigation Sidebar Drawer */}
        <aside className="lg:col-span-3 flex flex-col gap-4">
          <nav className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-2.5 rounded-3xl shadow-md flex flex-col gap-1">
            <button
              onClick={() => setActiveTab('students')}
              className={`flex items-center gap-3 px-4 py-3 rounded-2xl text-sm font-semibold transition-all cursor-pointer ${
                activeTab === 'students'
                  ? 'bg-violet-600/10 text-violet-600 dark:text-violet-400 border border-violet-500/10'
                  : 'text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-800 dark:hover:text-slate-200'
              }`}
            >
              <Users className="w-4 h-4" />
              Student Directory
            </button>

            <button
              onClick={() => setActiveTab('daily')}
              className={`flex items-center gap-3 px-4 py-3 rounded-2xl text-sm font-semibold transition-all cursor-pointer ${
                activeTab === 'daily'
                  ? 'bg-violet-600/10 text-violet-600 dark:text-violet-400 border border-violet-500/10'
                  : 'text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-800 dark:hover:text-slate-200'
              }`}
            >
              <ClipboardList className="w-4 h-4" />
              Attendance Control
            </button>

            <button
              onClick={() => setActiveTab('qr_attendance')}
              className={`flex items-center gap-3 px-4 py-3 rounded-2xl text-sm font-semibold transition-all cursor-pointer ${
                activeTab === 'qr_attendance'
                  ? 'bg-violet-600/10 text-violet-600 dark:text-violet-400 border border-violet-500/10'
                  : 'text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-800 dark:hover:text-slate-200'
              }`}
            >
              <QrCode className="w-4 h-4 text-violet-500" />
              QR Attendance
            </button>

            <button
              onClick={() => setActiveTab('monthly')}
              className={`flex items-center gap-3 px-4 py-3 rounded-2xl text-sm font-semibold transition-all cursor-pointer ${
                activeTab === 'monthly'
                  ? 'bg-violet-600/10 text-violet-600 dark:text-violet-400 border border-violet-500/10'
                  : 'text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-800 dark:hover:text-slate-200'
              }`}
            >
              <BarChart2 className="w-4 h-4" />
              Compliance Analytics
            </button>

            <button
              onClick={() => setActiveTab('profile')}
              className={`flex items-center gap-3 px-4 py-3 rounded-2xl text-sm font-semibold transition-all cursor-pointer ${
                activeTab === 'profile'
                  ? 'bg-violet-600/10 text-violet-600 dark:text-violet-400 border border-violet-500/10'
                  : 'text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-800 dark:hover:text-slate-200'
              }`}
            >
              <User className="w-4 h-4" />
              Staff Profile
            </button>
          </nav>

          {/* Read-Only Assigned Class Info Box */}
          {activeTab !== 'profile' && (
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-5 rounded-3xl shadow-md space-y-4">
              <div className="flex items-center justify-between">
                <h4 className="font-bold text-xs uppercase tracking-widest text-slate-400 font-mono flex items-center gap-1.5">
                  <ShieldCheck className="w-4 h-4 text-emerald-500" /> Class Assignment
                </h4>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-violet-500/10 text-violet-600 dark:text-violet-400 border border-violet-500/20">
                  Locked
                </span>
              </div>
              
              <div className="bg-slate-50 dark:bg-slate-950 p-3.5 rounded-2xl border border-slate-200/60 dark:border-slate-800 space-y-2">
                <div>
                  <span className="text-[10px] text-slate-400 uppercase font-mono block">Assigned Class</span>
                  <span className="text-base font-extrabold text-violet-600 dark:text-violet-400">
                    {assignedClass}
                  </span>
                </div>

                <div>
                  <span className="text-[10px] text-slate-400 uppercase font-mono block">Department</span>
                  <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                    {getDeptName(staffDepartment)}
                  </span>
                </div>

                <div>
                  <span className="text-[10px] text-slate-400 uppercase font-mono block">Staff Authority</span>
                  <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                    {staffProfile?.fullName || staffProfile?.staffName || userProfile?.name || 'Faculty Member'}
                  </span>
                </div>
              </div>

              {/* Target Date Selector */}
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1.5 flex items-center gap-1.5">
                  <Calendar className="w-3.5 h-3.5" /> Calendar Log Date
                </label>
                <input
                  type="date"
                  value={targetDate}
                  onChange={(e) => setTargetDate(e.target.value)}
                  className="w-full text-xs border border-slate-200 dark:border-slate-800 rounded-xl px-3 py-2 bg-slate-50 dark:bg-slate-950 focus:ring-2 focus:ring-violet-500 focus:outline-none"
                />
              </div>

              {/* Refresh Button */}
              <button
                onClick={loadData}
                disabled={loading}
                className="w-full flex justify-center items-center gap-2 py-2.5 px-4 border border-transparent rounded-xl text-xs font-semibold text-white bg-violet-600 hover:bg-violet-500 transition-all shadow-md cursor-pointer disabled:opacity-50"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
                Sync Class Records
              </button>
            </div>
          )}
        </aside>

        {/* Console Workspace Display */}
        <main className="lg:col-span-9 flex flex-col gap-6">
          <AnimatePresence mode="wait">
            
            {/* TAB 1: STUDENT DIRECTORY */}
            {activeTab === 'students' && (
              <motion.div
                key="students"
                initial={{ opacity: 0, x: 10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -10 }}
                className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl p-6 shadow-lg space-y-6"
              >
                {/* Search Bar */}
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                  <div>
                    <h2 className="text-lg font-bold tracking-tight flex items-center gap-2">
                      Classroom Directory <span className="text-xs px-2.5 py-1 bg-violet-500/10 text-violet-600 dark:text-violet-400 rounded-full font-mono">{assignedClass}</span>
                    </h2>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                      Students enrolled in assigned class ({assignedClass}).
                    </p>
                  </div>
                  
                  <div className="relative w-full md:max-w-xs">
                    <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      placeholder="Search name or roll..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="w-full text-xs pl-9 pr-4 py-2.5 border border-slate-200 dark:border-slate-800 rounded-xl bg-slate-50 dark:bg-slate-950 focus:outline-none focus:ring-2 focus:ring-violet-500"
                    />
                  </div>
                </div>

                {loading ? (
                  <div className="text-center py-12 text-slate-400">
                    <RefreshCw className="w-8 h-8 animate-spin mx-auto mb-2 text-violet-500" />
                    <span className="text-xs">Accessing databanks...</span>
                  </div>
                ) : filteredStudents.length === 0 ? (
                  <div className="text-center py-16 border border-dashed border-slate-200 dark:border-slate-800 rounded-2xl text-slate-400 text-xs">
                    No students registered in class {assignedClass}.
                  </div>
                ) : (
                  <div className="overflow-x-auto animate-fade-in">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-400 font-mono uppercase tracking-wider">
                          <th className="pb-3 font-semibold">Student Name</th>
                          <th className="pb-3 font-semibold">Roll Number</th>
                          <th className="pb-3 font-semibold">Assigned Class</th>
                          <th className="pb-3 font-semibold">Enrollment Status</th>
                          <th className="pb-3 font-semibold">Avg Attendance</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredStudents.map((s, idx) => (
                          <tr key={`${s.studentId || s.uid}-${s.rollNumber || ''}-${idx}`} className="border-b border-slate-100/50 dark:border-slate-800/50 hover:bg-slate-50/50 dark:hover:bg-slate-800/10">
                            <td className="py-4 font-semibold flex items-center gap-3">
                              <div className="w-8 h-8 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden flex items-center justify-center text-slate-400 shrink-0">
                                {s.photoURL ? (
                                  <img src={s.photoURL} alt="Avatar" className="w-full h-full object-cover text-[0px]" referrerPolicy="no-referrer" />
                                ) : (
                                  <Users className="w-4 h-4" />
                                )}
                              </div>
                              <div>
                                <span className="text-slate-800 dark:text-slate-200 font-bold block">{s.studentName}</span>
                                <span className="text-[10px] text-slate-400 font-medium block">{s.email}</span>
                              </div>
                            </td>
                            <td className="py-4 font-mono font-medium text-slate-500">{s.rollNumber}</td>
                            <td className="py-4 text-slate-600 dark:text-slate-300 font-bold">{assignedClass}</td>
                            <td className="py-4">
                              <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[10px] font-bold ${
                                s.faceRegistered 
                                  ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20' 
                                  : 'bg-amber-500/10 text-amber-500 border-amber-500/20'
                              }`}>
                                <div className={`w-1.5 h-1.5 rounded-full ${s.faceRegistered ? 'bg-emerald-500' : 'bg-amber-500 animate-pulse'}`} />
                                {s.faceRegistered ? 'Face Registered' : 'Missing Template'}
                              </span>
                            </td>
                            <td className="py-4 font-bold text-slate-800 dark:text-slate-200">{s.attendancePercentage}%</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </motion.div>
            )}

            {/* TAB 2: DAILY ATTENDANCE CONTROL */}
            {activeTab === 'daily' && (
              <motion.div
                key="daily"
                initial={{ opacity: 0, x: 10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -10 }}
                className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl p-6 shadow-lg space-y-6"
              >
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                  <div>
                    <h2 className="text-lg font-bold tracking-tight flex items-center gap-2">
                      Attendance Logs ({assignedClass}) <span className="text-xs font-mono text-slate-400">{targetDate}</span>
                    </h2>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">Review, override, and compile attendance for {assignedClass}.</p>
                  </div>

                  <div className="flex flex-wrap gap-2 items-center">
                    <button
                      onClick={() => setShowQRModal(true)}
                      className="px-3.5 py-2 border border-violet-500/30 rounded-xl bg-violet-600 text-white font-bold flex items-center gap-1.5 hover:bg-violet-500 transition-all text-xs cursor-pointer shadow-md shadow-violet-600/20"
                    >
                      <QrCode className="w-4 h-4" /> Class QR Code
                    </button>

                    <select 
                      value={reportType}
                      onChange={(e) => setReportType(e.target.value as any)}
                      className="text-xs border border-slate-200 dark:border-slate-800 rounded-xl px-2.5 py-2 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 font-bold focus:outline-none"
                    >
                      <option value="daily">Daily Report</option>
                      <option value="weekly">Weekly Summary</option>
                      <option value="monthly">Monthly Summary</option>
                    </select>

                    <button
                      onClick={handleExportExcel}
                      className="px-3.5 py-2 border border-slate-200 dark:border-slate-800 rounded-xl bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 font-bold flex items-center gap-1.5 hover:bg-slate-50 dark:hover:bg-slate-800 transition-all text-xs cursor-pointer"
                    >
                      <FileSpreadsheet className="w-4 h-4 text-emerald-500" /> Excel
                    </button>

                    <button
                      onClick={handleExportPDF}
                      className="px-3.5 py-2 border border-slate-200 dark:border-slate-800 rounded-xl bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 font-bold flex items-center gap-1.5 hover:bg-slate-50 dark:hover:bg-slate-800 transition-all text-xs cursor-pointer"
                    >
                      <FileText className="w-4 h-4 text-rose-500" /> PDF
                    </button>
                  </div>
                </div>

                {loading ? (
                  <div className="text-center py-12 text-slate-400">
                    <RefreshCw className="w-8 h-8 animate-spin mx-auto mb-2 text-violet-500" />
                    <span className="text-xs">Fetching attendance logs for {assignedClass}...</span>
                  </div>
                ) : dailyAttendanceReport.length === 0 ? (
                  <div className="text-center py-16 border border-dashed border-slate-200 dark:border-slate-800 rounded-2xl text-slate-400 text-xs">
                    No students listed in assigned class {assignedClass}.
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-400 font-mono uppercase tracking-wider">
                          <th className="pb-3 font-semibold">Student Name</th>
                          <th className="pb-3 font-semibold">Roll Number</th>
                          <th className="pb-3 font-semibold">Entry Time</th>
                          <th className="pb-3 font-semibold">Exit Time</th>
                          <th className="pb-3 font-semibold">Status</th>
                          <th className="pb-3 text-right">Faculty Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {dailyAttendanceReport.map(({ student, log }, idx) => {
                          const status = log?.overallStatus || 'Absent';
                          return (
                            <tr key={`${student.studentId || student.uid}-${student.rollNumber || ''}-${idx}`} className="border-b border-slate-100/50 dark:border-slate-800/50 hover:bg-slate-50/50 dark:hover:bg-slate-800/10">
                              <td className="py-4 font-bold text-slate-800 dark:text-slate-200">
                                {student.studentName}
                              </td>
                              <td className="py-4 font-mono text-slate-500">{student.rollNumber}</td>
                              <td className="py-4 font-mono text-slate-600 dark:text-slate-400">
                                {log?.entryTime ? formatTime12hr(log.entryTime) : '--:--'}
                              </td>
                              <td className="py-4 font-mono text-slate-600 dark:text-slate-400">
                                {log?.exitTime ? formatTime12hr(log.exitTime) : '--:--'}
                              </td>
                              <td className="py-4">
                                <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[10px] font-bold ${getStatusColorClass(status)}`}>
                                  {status}
                                </span>
                              </td>
                              <td className="py-4 text-right">
                                <div className="inline-flex gap-1.5 justify-end">
                                  <button
                                    onClick={() => handleReviewStatus(log?.attendanceId || `${student.uid}_${targetDate}`, 'Present')}
                                    className="px-2 py-1 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 rounded-lg text-[10px] font-bold cursor-pointer transition-all"
                                  >
                                    Present
                                  </button>
                                  <button
                                    onClick={() => handleReviewStatus(log?.attendanceId || `${student.uid}_${targetDate}`, 'Half Day')}
                                    className="px-2 py-1 bg-amber-500/10 hover:bg-amber-500/20 text-amber-600 dark:text-amber-400 border border-amber-500/20 rounded-lg text-[10px] font-bold cursor-pointer transition-all"
                                  >
                                    Half Day
                                  </button>
                                  <button
                                    onClick={() => handleReviewStatus(log?.attendanceId || `${student.uid}_${targetDate}`, 'Absent')}
                                    className="px-2 py-1 bg-rose-500/10 hover:bg-rose-500/20 text-rose-600 dark:text-rose-400 border border-rose-500/20 rounded-lg text-[10px] font-bold cursor-pointer transition-all"
                                  >
                                    Absent
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </motion.div>
            )}

            {/* TAB 3: COMPLIANCE ANALYTICS */}
            {activeTab === 'monthly' && (
              <motion.div
                key="monthly"
                initial={{ opacity: 0, x: 10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -10 }}
                className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl p-6 shadow-lg space-y-6"
              >
                <div>
                  <h2 className="text-lg font-bold tracking-tight flex items-center gap-2">
                    Classroom Compliance Analytics <span className="text-xs font-mono text-slate-400">{assignedClass}</span>
                  </h2>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">Classroom attendance trends and audit metrics for {assignedClass}.</p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="bg-slate-50/50 dark:bg-slate-950/20 border border-slate-200 dark:border-slate-800 p-5 rounded-2xl space-y-3">
                    <h3 className="font-bold text-xs uppercase tracking-widest text-slate-400 font-mono">Assigned Class Summary</h3>
                    <div className="space-y-2 text-xs">
                      <div className="flex justify-between py-1.5 border-b border-slate-200/50 dark:border-slate-800/50">
                        <span className="text-slate-500">Target Assigned Class</span>
                        <span className="font-bold text-violet-600 dark:text-violet-400">{assignedClass}</span>
                      </div>
                      <div className="flex justify-between py-1.5 border-b border-slate-200/50 dark:border-slate-800/50">
                        <span className="text-slate-500">Total Enrolled Students</span>
                        <span className="font-bold text-slate-800 dark:text-slate-100">{totalInScope}</span>
                      </div>
                      <div className="flex justify-between py-1.5 border-b border-slate-200/50 dark:border-slate-800/50">
                        <span className="text-slate-500">Present Count ({targetDate})</span>
                        <span className="font-bold text-emerald-500">{presentToday}</span>
                      </div>
                      <div className="flex justify-between py-1.5 border-b border-slate-200/50 dark:border-slate-800/50">
                        <span className="text-slate-500">Absent Count ({targetDate})</span>
                        <span className="font-bold text-rose-500">{absentToday}</span>
                      </div>
                      <div className="flex justify-between py-1.5">
                        <span className="text-slate-500">Class Attendance Rate</span>
                        <span className="font-bold text-slate-800 dark:text-slate-100">
                          {totalInScope > 0 ? `${Math.round((presentToday / totalInScope) * 100)}%` : '0%'}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="bg-slate-50/50 dark:bg-slate-950/20 border border-slate-200 dark:border-slate-800 p-5 rounded-2xl flex flex-col justify-between">
                    <h3 className="font-bold text-xs uppercase tracking-widest text-slate-400 font-mono">Quick Export Center</h3>
                    <p className="text-xs text-slate-500 my-3">Download complete attendance archives for class {assignedClass} in Excel or PDF format.</p>
                    <div className="flex gap-3">
                      <button
                        onClick={handleExportExcel}
                        className="flex-1 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-xl text-xs flex items-center justify-center gap-2 cursor-pointer shadow-md transition-all"
                      >
                        <FileSpreadsheet className="w-4 h-4" /> Export Excel
                      </button>
                      <button
                        onClick={handleExportPDF}
                        className="flex-1 py-2.5 bg-rose-600 hover:bg-rose-500 text-white font-bold rounded-xl text-xs flex items-center justify-center gap-2 cursor-pointer shadow-md transition-all"
                      >
                        <FileText className="w-4 h-4" /> Export PDF
                      </button>
                    </div>
                  </div>
                </div>
              </motion.div>
            )}

            {/* TAB: QR PERIOD ATTENDANCE */}
            {activeTab === 'qr_attendance' && (() => {
              const timetableStatus = getCurrentTimetableStatus(currentTime, simulatedPeriod);
              const activePeriodObj = timetableStatus.period;
              const activePeriodNum = activePeriodObj?.periodNumber || null;

              // Filter records for table
              const filteredPeriodRecords = periodAttendanceList.filter((record) => {
                if (selectedPeriodTab !== 'all' && record.period !== selectedPeriodTab) {
                  return false;
                }
                if (searchQuery.trim()) {
                  const q = searchQuery.toLowerCase();
                  return (
                    record.studentName.toLowerCase().includes(q) ||
                    record.rollNumber.toLowerCase().includes(q)
                  );
                }
                return true;
              });

              const studentsPresentInActive = activePeriodNum
                ? periodAttendanceList.filter((r) => r.period === activePeriodNum).length
                : 0;

              // Export QR period attendance to Excel
              const handleExportPeriodExcel = () => {
                try {
                  const exportRows = filteredPeriodRecords.map((r) => ({
                    'Date': r.date,
                    'Period': r.periodName,
                    'Time Range': r.periodTimeRange,
                    'Roll Number': r.rollNumber,
                    'Student Name': r.studentName,
                    'Assigned Class': r.assignedClass,
                    'Subject': r.subject,
                    'Scan Time': r.scanTime,
                    'Faculty': r.staffName,
                    'Method': r.attendanceMethod,
                    'Status': r.status,
                  }));
                  const ws = XLSX.utils.json_to_sheet(exportRows);
                  const wb = XLSX.utils.book_new();
                  XLSX.utils.book_append_sheet(wb, ws, `Period_Attendance_${targetDate}`);
                  XLSX.writeFile(wb, `Period_Attendance_${targetDate}.xlsx`);
                  success('Period attendance exported to Excel!');
                } catch (e: any) {
                  error('Failed to export period attendance.');
                }
              };

              // Export QR period attendance to PDF
              const handleExportPeriodPDF = () => {
                try {
                  const docPdf = new jsPDF();
                  docPdf.setFontSize(16);
                  docPdf.text(`College Period Attendance - ${targetDate}`, 14, 20);
                  docPdf.setFontSize(10);
                  docPdf.text(`Faculty: ${staffProfile?.fullName || staffProfile?.staffName || userProfile?.name || 'Staff'} | Class: ${assignedClass}`, 14, 28);
                  docPdf.text(`Generated on: ${new Date().toLocaleString()}`, 14, 34);

                  let y = 44;
                  docPdf.setFontSize(9);
                  docPdf.setFont('helvetica', 'bold');
                  docPdf.text('Roll No', 14, y);
                  docPdf.text('Student Name', 46, y);
                  docPdf.text('Period', 105, y);
                  docPdf.text('Scan Time', 135, y);
                  docPdf.text('Status', 170, y);
                  docPdf.setFont('helvetica', 'normal');

                  y += 6;
                  filteredPeriodRecords.slice(0, 38).forEach((r) => {
                    docPdf.text(r.rollNumber, 14, y);
                    docPdf.text(r.studentName.slice(0, 24), 46, y);
                    docPdf.text(`Period ${r.period}`, 105, y);
                    docPdf.text(r.scanTime, 135, y);
                    docPdf.text(r.status, 170, y);
                    y += 6;
                  });

                  docPdf.save(`Period_Attendance_${targetDate}.pdf`);
                  success('Period attendance exported to PDF!');
                } catch (e: any) {
                  error('Failed to export PDF.');
                }
              };

              return (
                <motion.div
                  key="qr_attendance"
                  initial={{ opacity: 0, x: 10 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -10 }}
                  className="space-y-6"
                >
                  {/* QR ATTENDANCE Top Command Card */}
                  <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl p-6 md:p-8 shadow-xl space-y-6">
                    <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-5">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="p-2 rounded-xl bg-violet-600/10 text-violet-600 dark:text-violet-400">
                            <QrCode className="w-5 h-5" />
                          </span>
                          <h2 className="text-xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
                            QR ATTENDANCE
                          </h2>
                          <span className="px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-violet-500/10 text-violet-600 dark:text-violet-400 border border-violet-500/20 font-mono">
                            5-Period System
                          </span>
                        </div>
                        <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                          Period attendance verification using student permanent QR tokens.
                        </p>
                      </div>

                      {/* Timetable Sandbox Override for Demonstration & Testing */}
                      <div className="flex items-center gap-2 bg-slate-50 dark:bg-slate-950 p-2 rounded-2xl border border-slate-200 dark:border-slate-800">
                        <label className="text-[11px] font-mono text-slate-500 whitespace-nowrap pl-1">
                          Timetable Mode:
                        </label>
                        <select
                          value={simulatedPeriod === null ? 'auto' : simulatedPeriod.toString()}
                          onChange={(e) => {
                            const val = e.target.value;
                            if (val === 'auto') {
                              setSimulatedPeriod(null);
                            } else {
                              setSimulatedPeriod(parseInt(val, 10));
                            }
                          }}
                          className="text-xs bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl px-2.5 py-1.5 font-semibold text-violet-600 dark:text-violet-400 focus:outline-none"
                        >
                          <option value="auto">Auto (Real-Time Clock)</option>
                          <option value="1">Period 1 (09:00 - 09:55 AM)</option>
                          <option value="2">Period 2 (09:55 - 10:50 AM)</option>
                          <option value="3">Period 3 (10:50 - 11:45 AM)</option>
                          <option value="-1">Lunch Break (11:45 - 12:40 PM)</option>
                          <option value="4">Period 4 (12:40 - 01:35 PM)</option>
                          <option value="5">Period 5 (01:35 - 02:30 PM)</option>
                        </select>
                      </div>
                    </div>

                    {/* Live Period & Attendance Metrics */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                      {/* Metric 1: Current Real Time */}
                      <div className="p-4 bg-slate-50 dark:bg-slate-950/70 border border-slate-200 dark:border-slate-800 rounded-2xl">
                        <div className="flex items-center justify-between text-slate-400 mb-1">
                          <span className="text-[10px] uppercase font-mono font-bold">Current Time</span>
                          <Clock className="w-4 h-4 text-violet-500" />
                        </div>
                        <h4 className="text-xl font-bold font-mono text-slate-800 dark:text-slate-100">
                          {currentTime.toLocaleTimeString('en-US', {
                            hour: '2-digit',
                            minute: '2-digit',
                            second: '2-digit',
                            hour12: true,
                          })}
                        </h4>
                        <p className="text-[10px] text-slate-400 mt-1 font-mono">{targetDate}</p>
                      </div>

                      {/* Metric 2: Current Period */}
                      <div className={`p-4 border rounded-2xl ${
                        timetableStatus.state === 'in_period'
                          ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-800 dark:text-emerald-200'
                          : timetableStatus.state === 'lunch_break'
                          ? 'bg-amber-500/10 border-amber-500/20 text-amber-800 dark:text-amber-200'
                          : 'bg-slate-50 dark:bg-slate-950/70 border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300'
                      }`}>
                        <div className="flex items-center justify-between opacity-80 mb-1">
                          <span className="text-[10px] uppercase font-mono font-bold">Current Period</span>
                          <span className="w-2.5 h-2.5 rounded-full bg-current animate-pulse" />
                        </div>
                        <h4 className="text-xl font-bold">
                          {activePeriodObj ? activePeriodObj.name : timetableStatus.state === 'lunch_break' ? 'Lunch Break' : 'Closed'}
                        </h4>
                        <p className="text-[10px] font-mono mt-1 opacity-90">
                          {activePeriodObj ? activePeriodObj.formattedRange : timetableStatus.message}
                        </p>
                      </div>

                      {/* Metric 3: Subject & Faculty */}
                      <div className="p-4 bg-slate-50 dark:bg-slate-950/70 border border-slate-200 dark:border-slate-800 rounded-2xl">
                        <div className="flex items-center justify-between text-slate-400 mb-1">
                          <span className="text-[10px] uppercase font-mono font-bold">Subject / Faculty</span>
                          <User className="w-4 h-4 text-violet-500" />
                        </div>
                        <input
                          type="text"
                          value={scanSubject}
                          onChange={(e) => setScanSubject(e.target.value)}
                          placeholder="Subject Name"
                          className="w-full text-sm font-bold text-slate-800 dark:text-slate-100 bg-transparent border-b border-transparent hover:border-slate-300 dark:hover:border-slate-700 focus:border-violet-500 focus:outline-none transition-all truncate"
                        />
                        <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-1 truncate">
                          Staff: {staffProfile?.fullName || staffProfile?.staffName || userProfile?.name || 'Staff Member'}
                        </p>
                      </div>

                      {/* Metric 4: Students Present in Period */}
                      <div className="p-4 bg-violet-500/10 border border-violet-500/20 rounded-2xl text-violet-900 dark:text-violet-100">
                        <div className="flex items-center justify-between opacity-80 mb-1">
                          <span className="text-[10px] uppercase font-mono font-bold">Students Present</span>
                          <CheckCircle className="w-4 h-4 text-violet-500" />
                        </div>
                        <h4 className="text-2xl font-extrabold font-mono text-violet-600 dark:text-violet-400">
                          {studentsPresentInActive}
                        </h4>
                        <p className="text-[10px] text-violet-500/80 font-mono mt-1">
                          {activePeriodObj ? `${activePeriodObj.name} Verified` : 'Total Active Period'}
                        </p>
                      </div>
                    </div>

                    {/* Scanner Trigger Button & Quick Action */}
                    <div className="flex flex-col sm:flex-row items-center justify-between gap-4 pt-2">
                      <button
                        onClick={() => setIsQrScannerOpen(!isQrScannerOpen)}
                        className={`w-full sm:w-auto px-6 py-3.5 rounded-2xl font-bold text-xs uppercase tracking-wider flex items-center justify-center gap-2.5 transition-all cursor-pointer shadow-lg ${
                          isQrScannerOpen
                            ? 'bg-rose-600 hover:bg-rose-500 text-white'
                            : 'bg-violet-600 hover:bg-violet-500 text-white'
                        }`}
                      >
                        <Camera className="w-4 h-4" />
                        {isQrScannerOpen ? 'CLOSE QR SCANNER' : 'OPEN QR SCANNER'}
                      </button>

                      <p className="text-xs text-slate-500 dark:text-slate-400 text-center sm:text-right">
                        Automatic validation: Student exists • College Face Entry checked • Duplicate prevented.
                      </p>
                    </div>

                    {/* Live Camera Scanner Container */}
                    {isQrScannerOpen && (
                      <div className="pt-4 border-t border-slate-200 dark:border-slate-800">
                        <QRScanner
                          onScan={handleScanQr}
                          onClose={() => setIsQrScannerOpen(false)}
                          isProcessing={isScanningProcessing}
                        />
                      </div>
                    )}

                    {/* Real-Time Scan Result Feedback Card */}
                    {lastScanResult && (
                      <div
                        className={`p-5 rounded-2xl border text-sm transition-all shadow-md ${
                          lastScanResult.type === 'success'
                            ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-800 dark:text-emerald-200'
                            : lastScanResult.type === 'duplicate'
                            ? 'bg-amber-500/10 border-amber-500/30 text-amber-800 dark:text-amber-200'
                            : lastScanResult.type === 'warning'
                            ? 'bg-rose-500/10 border-rose-500/30 text-rose-800 dark:text-rose-200'
                            : 'bg-rose-500/10 border-rose-500/30 text-rose-800 dark:text-rose-200'
                        }`}
                      >
                        <div className="flex items-start justify-between">
                          <div className="flex items-center gap-2.5 font-bold">
                            {lastScanResult.type === 'success' && (
                              <CheckCircle className="w-5 h-5 text-emerald-500" />
                            )}
                            {lastScanResult.type === 'duplicate' && (
                              <AlertCircle className="w-5 h-5 text-amber-500" />
                            )}
                            {(lastScanResult.type === 'warning' || lastScanResult.type === 'error') && (
                              <XCircle className="w-5 h-5 text-rose-500" />
                            )}
                            <span className="text-base">{lastScanResult.title}</span>
                          </div>

                          <button
                            onClick={() => setLastScanResult(null)}
                            className="text-xs opacity-60 hover:opacity-100 cursor-pointer"
                          >
                            ✕
                          </button>
                        </div>

                        {lastScanResult.studentName && (
                          <div className="mt-3 pt-3 border-t border-current/15 grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs font-mono">
                            <div>
                              <span className="opacity-70 block text-[10px]">Student</span>
                              <span className="font-bold">{lastScanResult.studentName}</span>
                            </div>
                            <div>
                              <span className="opacity-70 block text-[10px]">Register No</span>
                              <span className="font-bold">{lastScanResult.rollNumber || 'N/A'}</span>
                            </div>
                            {lastScanResult.period !== undefined && (
                              <div>
                                <span className="opacity-70 block text-[10px]">Period</span>
                                <span className="font-bold">Period {lastScanResult.period}</span>
                              </div>
                            )}
                            {lastScanResult.time && (
                              <div>
                                <span className="opacity-70 block text-[10px]">Time</span>
                                <span className="font-bold">{lastScanResult.time}</span>
                              </div>
                            )}
                          </div>
                        )}

                        <p className="mt-2 text-xs opacity-90">{lastScanResult.message}</p>

                        {lastScanResult.type === 'success' && (
                          <div className="mt-2 text-xs font-extrabold text-emerald-600 dark:text-emerald-400">
                            ✓ PRESENT
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Period Attendance Ledger Table */}
                  <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl p-6 shadow-xl space-y-5">
                    <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                      <div>
                        <h3 className="font-bold text-base text-slate-900 dark:text-slate-100 flex items-center gap-2">
                          Period Attendance Logs ({targetDate})
                        </h3>
                        <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                          List of students verified via QR attendance.
                        </p>
                      </div>

                      <div className="flex items-center gap-2">
                        <button
                          onClick={handleExportPeriodExcel}
                          className="px-3 py-2 rounded-xl text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white flex items-center gap-1.5 cursor-pointer shadow-sm"
                        >
                          <FileSpreadsheet className="w-3.5 h-3.5" /> Excel
                        </button>
                        <button
                          onClick={handleExportPeriodPDF}
                          className="px-3 py-2 rounded-xl text-xs font-semibold bg-rose-600 hover:bg-rose-500 text-white flex items-center gap-1.5 cursor-pointer shadow-sm"
                        >
                          <FileText className="w-3.5 h-3.5" /> PDF
                        </button>
                      </div>
                    </div>

                    {/* Period Filter Tabs */}
                    <div className="flex items-center gap-1.5 overflow-x-auto pb-1 border-b border-slate-200 dark:border-slate-800">
                      <button
                        onClick={() => setSelectedPeriodTab('all')}
                        className={`px-3 py-1.5 rounded-xl text-xs font-semibold whitespace-nowrap transition-all cursor-pointer ${
                          selectedPeriodTab === 'all'
                            ? 'bg-violet-600 text-white'
                            : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
                        }`}
                      >
                        All Periods ({periodAttendanceList.length})
                      </button>

                      {[1, 2, 3, 4, 5].map((pNum, idx) => {
                        const count = periodAttendanceList.filter((r) => r.period === pNum).length;
                        return (
                          <button
                            key={`period-btn-${pNum}-${idx}`}
                            onClick={() => setSelectedPeriodTab(pNum)}
                            className={`px-3 py-1.5 rounded-xl text-xs font-semibold whitespace-nowrap transition-all cursor-pointer ${
                              selectedPeriodTab === pNum
                                ? 'bg-violet-600 text-white'
                                : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
                            }`}
                          >
                            Period {pNum} ({count})
                          </button>
                        );
                      })}
                    </div>

                    {/* Table */}
                    <div className="overflow-x-auto">
                      <table className="w-full text-left border-collapse text-xs">
                        <thead>
                          <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-400 font-mono uppercase tracking-wider">
                            <th className="pb-3 font-semibold">Roll No</th>
                            <th className="pb-3 font-semibold">Student Name</th>
                            <th className="pb-3 font-semibold">Class</th>
                            <th className="pb-3 font-semibold">Period</th>
                            <th className="pb-3 font-semibold">Scan Time</th>
                            <th className="pb-3 font-semibold">Subject</th>
                            <th className="pb-3 font-semibold">Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {filteredPeriodRecords.length === 0 ? (
                            <tr>
                              <td colSpan={7} className="py-8 text-center text-slate-400">
                                No QR attendance records found for this period filter on {targetDate}.
                              </td>
                            </tr>
                          ) : (
                            filteredPeriodRecords.map((rec, idx) => (
                              <tr
                                key={`${rec.recordId || rec.studentId || 'rec'}-${idx}`}
                                className="border-b border-slate-100 dark:border-slate-800/60 hover:bg-slate-50/50 dark:hover:bg-slate-800/20"
                              >
                                <td className="py-3 font-mono font-bold text-violet-600 dark:text-violet-400">
                                  {rec.rollNumber}
                                </td>
                                <td className="py-3 font-semibold text-slate-800 dark:text-slate-200">
                                  {rec.studentName}
                                </td>
                                <td className="py-3 text-slate-500 font-mono">
                                  {rec.assignedClass}
                                </td>
                                <td className="py-3 font-mono">
                                  <span className="px-2 py-0.5 rounded-md bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-semibold">
                                    {rec.periodName}
                                  </span>
                                </td>
                                <td className="py-3 font-mono text-slate-600 dark:text-slate-300">
                                  {rec.scanTime}
                                </td>
                                <td className="py-3 text-slate-500 truncate max-w-[120px]">
                                  {rec.subject || 'Lecture'}
                                </td>
                                <td className="py-3 font-bold text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
                                  <CheckCircle className="w-3.5 h-3.5" /> PRESENT
                                </td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </motion.div>
              );
            })()}

            {/* TAB 4: STAFF PROFILE */}
            {activeTab === 'profile' && (
              <motion.div
                key="profile"
                initial={{ opacity: 0, x: 10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -10 }}
                className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl p-6 shadow-lg space-y-6"
              >
                <div>
                  <h2 className="text-lg font-bold tracking-tight">Faculty Account Details</h2>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">Manage profile information and security credentials.</p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {/* Edit Profile Form */}
                  <form onSubmit={handleSaveProfile} className="bg-slate-50/50 dark:bg-slate-950/20 border border-slate-200 dark:border-slate-800 p-5 rounded-2xl space-y-4">
                    <h3 className="font-bold text-xs uppercase tracking-widest text-slate-400 font-mono">Profile Details</h3>

                    <div>
                      <label className="block text-xs font-medium text-slate-500 mb-1">Full Name</label>
                      <input
                        type="text"
                        required
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        className="w-full text-xs border border-slate-200 dark:border-slate-800 rounded-xl px-3 py-2.5 bg-white dark:bg-slate-950 focus:outline-none focus:ring-2 focus:ring-violet-500"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-slate-500 mb-1">Staff ID</label>
                      <input
                        type="text"
                        disabled
                        value={staffProfile?.staffId || userProfile?.uid || ''}
                        className="w-full text-xs border border-slate-200 dark:border-slate-800 rounded-xl px-3 py-2.5 bg-slate-100 dark:bg-slate-900 text-slate-500 font-mono"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-slate-500 mb-1">Assigned Class (Locked)</label>
                      <input
                        type="text"
                        disabled
                        value={`${assignedClass} (${getDeptName(staffDepartment)})`}
                        className="w-full text-xs border border-slate-200 dark:border-slate-800 rounded-xl px-3 py-2.5 bg-slate-100 dark:bg-slate-900 text-violet-600 dark:text-violet-400 font-bold"
                      />
                    </div>

                    <button
                      type="submit"
                      disabled={isSavingProfile}
                      className="w-full py-2.5 bg-violet-600 hover:bg-violet-500 text-white rounded-xl font-semibold text-xs transition-all cursor-pointer shadow-md"
                    >
                      {isSavingProfile ? 'Saving...' : 'Save Profile Changes'}
                    </button>
                  </form>

                  {/* Change Password Form */}
                  <form onSubmit={handleChangePassword} className="bg-slate-50/50 dark:bg-slate-950/20 border border-slate-200 dark:border-slate-800 p-5 rounded-2xl space-y-4">
                    <h3 className="font-bold text-xs uppercase tracking-widest text-slate-400 font-mono">Security Credentials</h3>

                    <div>
                      <label className="block text-xs font-medium text-slate-500 mb-1">New Password</label>
                      <input
                        type="password"
                        required
                        value={newPassword}
                        onChange={(e) => setNewPassword(e.target.value)}
                        placeholder="••••••••"
                        className="w-full text-xs border border-slate-200 dark:border-slate-800 rounded-xl px-3 py-2.5 bg-white dark:bg-slate-950 focus:outline-none focus:ring-2 focus:ring-violet-500"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-slate-500 mb-1">Confirm New Password</label>
                      <input
                        type="password"
                        required
                        value={confirmNewPassword}
                        onChange={(e) => setConfirmNewPassword(e.target.value)}
                        placeholder="••••••••"
                        className="w-full text-xs border border-slate-200 dark:border-slate-800 rounded-xl px-3 py-2.5 bg-white dark:bg-slate-950 focus:outline-none focus:ring-2 focus:ring-violet-500"
                      />
                    </div>

                    <button
                      type="submit"
                      disabled={isChangingPassword}
                      className="w-full py-2.5 bg-slate-800 hover:bg-slate-700 text-white rounded-xl font-semibold text-xs transition-all cursor-pointer shadow-md"
                    >
                      {isChangingPassword ? 'Updating...' : 'Update Password'}
                    </button>
                  </form>
                </div>
              </motion.div>
            )}

          </AnimatePresence>
        </main>
      </div>

      {/* Class QR Code Modal */}
      {showQRModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex items-center justify-center p-4">
          <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl p-6 max-w-sm w-full text-center space-y-4 shadow-2xl"
          >
            <div className="flex justify-between items-center border-b border-slate-200 dark:border-slate-800 pb-3">
              <h3 className="font-bold text-sm text-slate-800 dark:text-slate-100 flex items-center gap-2">
                <QrCode className="w-5 h-5 text-violet-500" /> Class QR Code
              </h3>
              <button
                onClick={() => setShowQRModal(false)}
                className="text-slate-400 hover:text-slate-600 text-sm font-bold cursor-pointer"
              >
                ✕
              </button>
            </div>

            <p className="text-xs text-slate-500">
              Students in <strong className="text-violet-600 dark:text-violet-400">{assignedClass}</strong> can scan this QR code to mark attendance for <span className="font-mono">{targetDate}</span>.
            </p>

            <div className="p-4 bg-white rounded-2xl border border-slate-200 flex justify-center shadow-inner">
              <img src={qrCodeUrl} alt="Class QR Code" className="w-48 h-48 object-contain" />
            </div>

            <div className="pt-2">
              <button
                onClick={() => setShowQRModal(false)}
                className="w-full py-2.5 bg-violet-600 hover:bg-violet-500 text-white rounded-xl text-xs font-semibold cursor-pointer"
              >
                Close QR Code
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </div>
  );
};

export default StaffDashboard;
