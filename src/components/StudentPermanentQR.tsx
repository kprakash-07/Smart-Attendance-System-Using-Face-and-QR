import React, { useEffect, useState, useRef } from 'react';
import { StudentProfile, PeriodAttendanceRecord } from '../types';
import { encodeStudentQrPayload, generateQrDataUrl } from '../utils/qrUtils';
import { COLLEGE_TIMETABLE } from '../utils/timetableUtils';
import { 
  QrCode, Download, Eye, ShieldCheck, CheckCircle2, 
  Clock, AlertCircle, Sparkles, X, User, School, Calendar
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useToast } from '../contexts/ToastContext';

interface StudentPermanentQRProps {
  studentProfile: StudentProfile;
  todayPeriodAttendance: PeriodAttendanceRecord[];
  hasCollegeEntryToday: boolean;
}

export const StudentPermanentQR: React.FC<StudentPermanentQRProps> = ({
  studentProfile,
  todayPeriodAttendance,
  hasCollegeEntryToday,
}) => {
  const { success, error } = useToast();
  const [qrDataUrl, setQrDataUrl] = useState<string>('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const cardRef = useRef<HTMLDivElement | null>(null);

  const qrId = studentProfile.qrId;
  const qrPayload = qrId ? encodeStudentQrPayload(qrId, studentProfile.uid) : '';

  useEffect(() => {
    let isMounted = true;
    if (qrPayload) {
      setIsGenerating(true);
      generateQrDataUrl(qrPayload, { width: 360, margin: 2, darkColor: '#0f172a' })
        .then((url) => {
          if (isMounted) setQrDataUrl(url);
        })
        .catch((err) => {
          console.error('Failed to generate QR data URL:', err);
        })
        .finally(() => {
          if (isMounted) setIsGenerating(false);
        });
    }
    return () => {
      isMounted = false;
    };
  }, [qrPayload]);

  // Download QR as PNG with student ID card branding
  const handleDownloadQR = () => {
    if (!qrDataUrl) {
      error('QR code is still loading. Please try again.');
      return;
    }

    try {
      const canvas = document.createElement('canvas');
      canvas.width = 600;
      canvas.height = 760;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      // Background gradient
      const grad = ctx.createLinearGradient(0, 0, 0, 760);
      grad.addColorStop(0, '#0f172a');
      grad.addColorStop(1, '#1e1b4b');
      ctx.fillStyle = grad;
      ctx.roundRect ? ctx.roundRect(0, 0, 600, 760, 36) : ctx.fillRect(0, 0, 600, 760);
      ctx.fill();

      // Card Header
      ctx.fillStyle = '#8b5cf6';
      ctx.font = 'bold 20px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('COLLEGE SMART ATTENDANCE', 300, 56);

      ctx.fillStyle = '#f8fafc';
      ctx.font = 'bold 26px sans-serif';
      ctx.fillText('Permanent Student QR', 300, 95);

      ctx.fillStyle = '#94a3b8';
      ctx.font = '14px sans-serif';
      ctx.fillText('Official Biometric Token for Period Attendance', 300, 122);

      // Student info block
      ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
      ctx.roundRect ? ctx.roundRect(40, 146, 520, 100, 16) : ctx.fillRect(40, 146, 520, 100);
      ctx.fill();

      ctx.textAlign = 'left';
      ctx.fillStyle = '#cbd5e1';
      ctx.font = '13px monospace';
      ctx.fillText('STUDENT NAME:', 60, 178);
      ctx.fillText('REGISTER NUMBER:', 60, 206);
      ctx.fillText('ASSIGNED CLASS:', 60, 234);

      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 16px sans-serif';
      ctx.fillText(studentProfile.studentName || 'Student', 240, 178);
      ctx.fillStyle = '#a78bfa';
      ctx.font = 'bold 16px monospace';
      ctx.fillText(studentProfile.rollNumber || 'N/A', 240, 206);
      ctx.fillStyle = '#e2e8f0';
      ctx.font = 'bold 14px sans-serif';
      ctx.fillText(studentProfile.assignedClass || studentProfile.year || 'Student Member', 240, 234);

      // QR Image
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        // Draw white container for QR
        ctx.fillStyle = '#ffffff';
        ctx.roundRect ? ctx.roundRect(140, 270, 320, 320, 24) : ctx.fillRect(140, 270, 320, 320);
        ctx.fill();

        ctx.drawImage(img, 155, 285, 290, 290);

        // Instruction
        ctx.textAlign = 'center';
        ctx.fillStyle = '#f1f5f9';
        ctx.font = 'bold 16px sans-serif';
        ctx.fillText('Use this QR for period attendance.', 300, 630);

        ctx.fillStyle = '#94a3b8';
        ctx.font = '12px sans-serif';
        ctx.fillText('Permanent token • Valid across all 5 daily college periods', 300, 655);
        ctx.fillText('Requires Gate Face Entry verification for activation', 300, 675);

        // Footer brand
        ctx.fillStyle = '#64748b';
        ctx.font = '11px monospace';
        ctx.fillText(`ID: ${qrId || studentProfile.uid}`, 300, 725);

        const a = document.createElement('a');
        a.download = `Student_QR_${studentProfile.rollNumber || studentProfile.uid}.png`;
        a.href = canvas.toDataURL('image/png');
        a.click();
        success('Permanent Student QR downloaded successfully!');
      };
      img.src = qrDataUrl;
    } catch (err) {
      console.error('Download error:', err);
      error('Failed to generate download. Please right click and save image.');
    }
  };

  const activePeriods = COLLEGE_TIMETABLE.filter((p) => !p.isLunch);

  return (
    <div className="bg-white/90 dark:bg-slate-900/90 backdrop-blur-md border border-slate-200 dark:border-slate-800 rounded-3xl p-6 md:p-8 shadow-xl space-y-6">
      {/* Section Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-5">
        <div className="flex items-center gap-3">
          <div className="p-3 bg-violet-600/10 text-violet-600 dark:text-violet-400 rounded-2xl border border-violet-500/20">
            <QrCode className="w-6 h-6" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="font-bold text-lg text-slate-800 dark:text-slate-100">
                Permanent Student QR
              </h3>
              <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                Permanent Token
              </span>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Use this QR for period attendance across all 5 college periods.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setIsModalOpen(true)}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 transition-all cursor-pointer"
          >
            <Eye className="w-3.5 h-3.5" /> View QR
          </button>
          <button
            onClick={handleDownloadQR}
            disabled={!qrDataUrl}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold bg-violet-600 hover:bg-violet-500 text-white transition-all cursor-pointer shadow-md disabled:opacity-50"
          >
            <Download className="w-3.5 h-3.5" /> Save QR
          </button>
        </div>
      </div>

      {/* Main Content Layout: QR Card + Period Attendance Progress */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-center">
        {/* QR Card Presentation */}
        <div className="lg:col-span-5 flex flex-col items-center">
          <div
            onClick={() => setIsModalOpen(true)}
            className="group relative cursor-pointer bg-gradient-to-br from-slate-900 to-indigo-950 text-white p-5 rounded-3xl shadow-xl border border-violet-500/20 max-w-xs w-full transition-transform hover:scale-[1.02]"
          >
            {/* Holographic accent glow */}
            <div className="absolute top-0 right-0 w-24 h-24 bg-violet-500/10 rounded-full blur-xl pointer-events-none" />

            <div className="flex items-center justify-between mb-3 border-b border-white/10 pb-2">
              <div>
                <span className="text-[10px] font-mono text-violet-300 font-bold uppercase tracking-wider block">
                  STUDENT ATTENDANCE ID
                </span>
                <h4 className="text-sm font-bold text-white truncate max-w-[180px]">
                  {studentProfile.studentName || 'Student Name'}
                </h4>
              </div>
              <span className="text-xs font-mono font-bold text-violet-400 bg-violet-500/20 px-2 py-0.5 rounded-lg border border-violet-500/30">
                {studentProfile.rollNumber || 'ROLL NO'}
              </span>
            </div>

            {/* QR Image Display */}
            <div className="bg-white p-3 rounded-2xl shadow-inner flex flex-col items-center justify-center my-2">
              {qrDataUrl ? (
                <img
                  src={qrDataUrl}
                  alt="Student Permanent Attendance QR"
                  className="w-48 h-48 object-contain"
                />
              ) : (
                <div className="w-48 h-48 flex items-center justify-center text-slate-400">
                  <div className="w-8 h-8 border-3 border-violet-500 border-t-transparent rounded-full animate-spin" />
                </div>
              )}
              <span className="text-[10px] text-slate-500 font-mono mt-1 font-semibold">
                Permanent Attendance Token
              </span>
            </div>

            {/* Short instruction text as specified */}
            <div className="text-center pt-2">
              <p className="text-xs font-semibold text-violet-200">
                "Use this QR for period attendance."
              </p>
              <p className="text-[10px] text-slate-400 mt-0.5">
                Click to expand full screen card
              </p>
            </div>
          </div>
        </div>

        {/* Period Attendance Status for Today */}
        <div className="lg:col-span-7 flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <h4 className="font-bold text-sm text-slate-800 dark:text-slate-200 flex items-center gap-2">
              <Clock className="w-4 h-4 text-violet-500" /> Today's Period Attendance Status
            </h4>
            <span className="text-xs text-slate-400 font-mono">5 College Periods</span>
          </div>

          {/* Gate Face Entry Prerequisite Status */}
          <div
            className={`p-3.5 rounded-2xl border text-xs flex items-center gap-3 ${
              hasCollegeEntryToday
                ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-700 dark:text-emerald-300'
                : 'bg-amber-500/10 border-amber-500/20 text-amber-700 dark:text-amber-300'
            }`}
          >
            {hasCollegeEntryToday ? (
              <CheckCircle2 className="w-5 h-5 text-emerald-500 shrink-0" />
            ) : (
              <AlertCircle className="w-5 h-5 text-amber-500 shrink-0" />
            )}
            <div>
              <p className="font-bold">
                {hasCollegeEntryToday
                  ? 'College Gate Face Entry: Verified Today'
                  : 'College Gate Face Entry: Pending Today'}
              </p>
              <p className="text-[11px] opacity-80 mt-0.5">
                {hasCollegeEntryToday
                  ? 'Your period QR scans are unlocked and ready for faculty period checks.'
                  : 'You must first verify face recognition at the college entrance before period QR scans are validated.'}
              </p>
            </div>
          </div>

          {/* Periods 1-5 Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
            {activePeriods.map((period, idx) => {
              const record = todayPeriodAttendance.find((r) => r.period === period.periodNumber);
              const isMarked = !!record;

              return (
                <div
                  key={`qr-period-${period.periodNumber}-${idx}`}
                  className={`p-3 rounded-2xl border transition-all ${
                    isMarked
                      ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-800 dark:text-emerald-200'
                      : 'bg-slate-50 dark:bg-slate-950/60 border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-bold text-xs font-mono">{period.name}</span>
                    <span
                      className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                        isMarked
                          ? 'bg-emerald-500 text-white'
                          : 'bg-slate-200 dark:bg-slate-800 text-slate-500 dark:text-slate-400'
                      }`}
                    >
                      {isMarked ? 'PRESENT' : 'Pending'}
                    </span>
                  </div>
                  <p className="text-[10px] font-mono opacity-80">{period.formattedRange}</p>
                  {record && (
                    <p className="text-[10px] font-semibold text-emerald-600 dark:text-emerald-400 mt-1 flex items-center gap-1">
                      <CheckCircle2 className="w-3 h-3" /> Scanned at {record.scanTime}
                    </p>
                  )}
                </div>
              );
            })}
          </div>

          {/* Anti-Proxy Architecture Transparency Note */}
          <div className="p-3 bg-slate-50 dark:bg-slate-950/40 border border-slate-200 dark:border-slate-800/80 rounded-2xl text-[11px] text-slate-500 dark:text-slate-400 space-y-1">
            <div className="flex items-center gap-1.5 font-semibold text-slate-700 dark:text-slate-300">
              <ShieldCheck className="w-3.5 h-3.5 text-violet-500" />
              Two-Tier Security Architecture
            </div>
            <p>
              • <strong>Face Biometrics:</strong> Mandatory Gate Entry & Exit stamps physical presence.
              <br />
              • <strong>Permanent QR:</strong> Validates classroom period attendance by authorized faculty.
              <br />
              • <strong>Proxy Defense:</strong> The system strictly rejects period QR attendance if the student has not verified their face at the entrance gate today.
            </p>
          </div>
        </div>
      </div>

      {/* Full QR Modal */}
      <AnimatePresence>
        {isModalOpen && (
          <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
            <motion.div
              initial={{ scale: 0.92, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.92, opacity: 0 }}
              className="bg-slate-900 border border-slate-800 text-white rounded-3xl p-6 md:p-8 max-w-sm w-full space-y-5 shadow-2xl relative"
            >
              {/* Close Button */}
              <button
                onClick={() => setIsModalOpen(false)}
                className="absolute top-4 right-4 p-2 rounded-xl bg-slate-800 text-slate-400 hover:text-white transition-all cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>

              <div className="text-center space-y-1">
                <span className="text-[10px] font-mono text-violet-400 uppercase tracking-widest font-bold">
                  OFFICIAL ATTENDANCE TOKEN
                </span>
                <h3 className="text-xl font-bold text-white">Permanent Student QR</h3>
                <p className="text-xs text-slate-400">
                  Present this QR code to faculty during period attendance.
                </p>
              </div>

              {/* Student Identification Details */}
              <div className="bg-slate-950 p-4 rounded-2xl border border-slate-800 space-y-2">
                <div className="flex justify-between items-center text-xs">
                  <span className="text-slate-400">Student Name:</span>
                  <span className="font-bold text-white">{studentProfile.studentName}</span>
                </div>
                <div className="flex justify-between items-center text-xs">
                  <span className="text-slate-400">Register Number:</span>
                  <span className="font-mono font-bold text-violet-400">
                    {studentProfile.rollNumber}
                  </span>
                </div>
                <div className="flex justify-between items-center text-xs">
                  <span className="text-slate-400">Class / Dept:</span>
                  <span className="font-semibold text-slate-200">
                    {studentProfile.assignedClass || studentProfile.department}
                  </span>
                </div>
              </div>

              {/* Large High Contrast QR */}
              <div className="bg-white p-4 rounded-2xl flex flex-col items-center justify-center shadow-lg">
                {qrDataUrl ? (
                  <img
                    src={qrDataUrl}
                    alt="Student Permanent Attendance QR"
                    className="w-56 h-56 object-contain"
                  />
                ) : (
                  <div className="w-56 h-56 flex items-center justify-center text-slate-400">
                    <div className="w-8 h-8 border-3 border-violet-500 border-t-transparent rounded-full animate-spin" />
                  </div>
                )}
                <span className="text-[11px] font-mono text-slate-600 mt-2 font-bold">
                  Use this QR for period attendance.
                </span>
              </div>

              {/* Action Buttons */}
              <div className="grid grid-cols-2 gap-3 pt-2">
                <button
                  onClick={handleDownloadQR}
                  className="w-full py-2.5 bg-violet-600 hover:bg-violet-500 text-white rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer shadow-md"
                >
                  <Download className="w-4 h-4" /> Download QR
                </button>
                <button
                  onClick={() => setIsModalOpen(false)}
                  className="w-full py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl text-xs font-semibold cursor-pointer"
                >
                  Close
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default StudentPermanentQR;
