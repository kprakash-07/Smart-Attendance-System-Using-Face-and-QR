import React, { createContext, useContext, useEffect, useState } from 'react';
import { 
  onAuthStateChanged, 
  signInWithEmailAndPassword, 
  createUserWithEmailAndPassword, 
  sendPasswordResetEmail,
  signOut, 
  User as FirebaseUser,
  updateProfile
} from 'firebase/auth';
import { 
  doc, 
  getDoc, 
  setDoc, 
  serverTimestamp,
  collection,
  query,
  where,
  getDocs,
  deleteDoc
} from 'firebase/firestore';
import { auth, db } from '../firebase/firebase';
import { UserProfile, StudentProfile, StaffProfile } from '../types';
import { getYearFromClass, getClassFromDeptAndYear } from '../utils/academicData';

interface AuthContextType {
  currentUser: FirebaseUser | null;
  userProfile: UserProfile | null;
  studentProfile: StudentProfile | null;
  staffProfile: StaffProfile | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<UserProfile>;
  signUpStudent: (data: {
    studentName: string;
    rollNumber: string;
    department: string;
    year: string;
    email: string;
    password: string;
  }) => Promise<void>;
  signUpStaff: (data: {
    fullName: string;
    staffId: string;
    department: string;
    assignedClass: string;
    year?: string;
    email: string;
    password: string;
  }) => Promise<void>;
  updateStudentProfileDetails: (details: {
    studentName: string;
    rollNumber: string;
    department: string;
    year: string;
  }) => Promise<void>;
  logout: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  resetPassword: (email: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [currentUser, setCurrentUser] = useState<FirebaseUser | null>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [studentProfile, setStudentProfile] = useState<StudentProfile | null>(null);
  const [staffProfile, setStaffProfile] = useState<StaffProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const isAuthActionInProgressRef = React.useRef(false);

  const getDocWithRetry = async (docRef: any, retries = 3, delay = 1000): Promise<any> => {
    try {
      return await getDoc(docRef);
    } catch (error: any) {
      if (retries > 0) {
        console.warn(`Firestore getDoc failed. Retrying in ${delay}ms... Remaining retries: ${retries}`, error);
        await new Promise(resolve => setTimeout(resolve, delay));
        return getDocWithRetry(docRef, retries - 1, delay * 1.5);
      }
      throw error;
    }
  };

  const fetchExtendedProfiles = async (uid: string, role: 'student' | 'staff' | 'admin') => {
    try {
      if (role === 'student') {
        const studentDocRef = doc(db, 'students', uid);
        const studentSnap = await getDocWithRetry(studentDocRef);
        if (studentSnap.exists()) {
          const sData = studentSnap.data() as StudentProfile;
          setStudentProfile({ ...sData, uid, studentId: uid });
        } else {
          // If student doc missing, check userProfile and pre-enrolled documents
          const uSnap = await getDocWithRetry(doc(db, 'users', uid));
          const uData = uSnap?.data();
          const cleanEmail = (uData?.email || auth.currentUser?.email || '').toLowerCase().trim();

          // Check if admin pre-enrolled this email under a temporary ID
          let preEnrolled: StudentProfile | null = null;
          if (cleanEmail && cleanEmail.length > 3) {
            try {
              const qPre = query(collection(db, 'students'), where('email', '==', cleanEmail));
              const preSnap = await getDocs(qPre);
              for (const pDoc of preSnap.docs) {
                if (pDoc.id !== uid && pDoc.data().email?.toLowerCase() === cleanEmail) {
                  preEnrolled = pDoc.data() as StudentProfile;
                  try {
                    await deleteDoc(doc(db, 'students', pDoc.id));
                  } catch (e) {}
                  break;
                }
              }
            } catch (preErr) {
              console.warn("Pre-enrollment check notice in fetchExtendedProfiles:", preErr);
            }
          }

          const fallbackName = preEnrolled?.studentName || uData?.name || auth.currentUser?.displayName || 'Student Account';
          const rollNumber = preEnrolled?.rollNumber || uData?.rollNumber || `STU-${uid.slice(0, 6).toUpperCase()}`;
          const department = preEnrolled?.department || uData?.department || 'computer_science';
          const year = preEnrolled?.year || uData?.year || '1st Year';

          const newStud: StudentProfile = {
            studentId: uid,
            uid,
            studentName: fallbackName,
            rollNumber,
            department,
            year,
            email: cleanEmail,
            faceRegistered: preEnrolled?.faceRegistered || false,
            attendancePercentage: preEnrolled?.attendancePercentage ?? 100,
            photoURL: preEnrolled?.photoURL || ""
          };
          await setDoc(doc(db, 'students', uid), newStud, { merge: true });
          setStudentProfile(newStud);
        }
        setStaffProfile(null);
      } else if (role === 'staff') {
        let staffSnap = await getDocWithRetry(doc(db, 'staffs', uid));
        if (!staffSnap || !staffSnap.exists()) {
          staffSnap = await getDocWithRetry(doc(db, 'staff', uid));
        }
        
        if (staffSnap && staffSnap.exists()) {
          const sData = staffSnap.data() as StaffProfile;
          const sDept = sData.department || 'CS';
          const sYear = sData.year || (sData as any).academicYear || getYearFromClass(sData.assignedClass);
          const sClass = sData.assignedClass || getClassFromDeptAndYear(sDept, sYear);
          const loadedStaff: StaffProfile = {
            ...sData,
            fullName: sData.fullName || sData.staffName || 'Faculty Member',
            staffName: sData.staffName || sData.fullName || 'Faculty Member',
            assignedClass: sClass,
            year: sYear,
            academicYear: sYear,
            department: sDept,
            staffId: sData.staffId || uid,
            uid: uid,
            email: sData.email || auth.currentUser?.email || '',
            role: 'staff'
          };
          setStaffProfile(loadedStaff);
        } else {
          // Self-heal missing staff profile
          const uSnap = await getDocWithRetry(doc(db, 'users', uid));
          const uData = uSnap?.data();
          const fullName = uData?.name || auth.currentUser?.displayName || 'Faculty Member';
          const email = uData?.email || auth.currentUser?.email || '';
          const fallbackStaff: StaffProfile = {
            uid,
            staffId: 'STF-' + uid.slice(0, 6).toUpperCase(),
            fullName,
            staffName: fullName,
            email,
            department: 'CS',
            assignedClass: 'CS - I',
            year: '1st Year',
            academicYear: '1st Year',
            role: 'staff',
            createdAt: new Date().toISOString()
          };
          await setDoc(doc(db, 'staffs', uid), fallbackStaff, { merge: true });
          await setDoc(doc(db, 'staff', uid), fallbackStaff, { merge: true });
          setStaffProfile(fallbackStaff);
        }
        setStudentProfile(null);
      } else {
        // Admin
        setStudentProfile(null);
        setStaffProfile(null);
      }
    } catch (err) {
      console.error("Error fetching extended profile:", err);
    }
  };

  const fetchProfileByUid = async (uid: string, fallbackEmail?: string): Promise<UserProfile | null> => {
    try {
      // 1. Check staffs collection first
      let staffSnap = await getDocWithRetry(doc(db, 'staffs', uid));
      if (!staffSnap || !staffSnap.exists()) {
        staffSnap = await getDocWithRetry(doc(db, 'staff', uid));
      }

      if (staffSnap && staffSnap.exists()) {
        const staffData = staffSnap.data() as StaffProfile;
        const staffUserProfile: UserProfile = {
          uid,
          name: staffData.fullName || staffData.staffName || 'Faculty Member',
          email: staffData.email || fallbackEmail || '',
          role: 'staff',
          createdAt: staffData.createdAt || new Date().toISOString()
        };
        // Sync to users collection
        await setDoc(doc(db, 'users', uid), staffUserProfile, { merge: true });
        return staffUserProfile;
      }

      // 2. Check students collection
      const studentSnap = await getDocWithRetry(doc(db, 'students', uid));
      if (studentSnap && studentSnap.exists()) {
        const studData = studentSnap.data() as StudentProfile;
        const studentUserProfile: UserProfile = {
          uid,
          name: studData.studentName || 'Student',
          email: studData.email || fallbackEmail || '',
          role: 'student',
          createdAt: new Date().toISOString()
        };
        await setDoc(doc(db, 'users', uid), studentUserProfile, { merge: true });
        return studentUserProfile;
      }

      // 3. Check users collection
      const userSnap = await getDocWithRetry(doc(db, 'users', uid));
      if (userSnap && userSnap.exists()) {
        return userSnap.data() as UserProfile;
      }

      return null;
    } catch (err) {
      console.error("Error fetching profile by UID:", err);
      return null;
    }
  };

  const healMissingUserProfile = async (uid: string, email: string): Promise<UserProfile> => {
    try {
      const cleanEmail = (email || auth.currentUser?.email || '').toLowerCase().trim();

      // 1. Check existing profile in staffs, students, or users by direct UID
      const existingProfile = await fetchProfileByUid(uid, cleanEmail);
      if (existingProfile) {
        return existingProfile;
      }

      console.log(`User profile missing for UID: ${uid} (${cleanEmail}). Initiating self-healing...`);

      // 2. Check if admin email
      if (cleanEmail === 'admin@college.com' || cleanEmail === 'admin@example.com' || cleanEmail.startsWith('admin@')) {
        const adminProfile: UserProfile = {
          uid,
          name: auth.currentUser?.displayName || 'Administrator',
          email: cleanEmail,
          role: 'admin',
          createdAt: new Date().toISOString()
        };
        await setDoc(doc(db, 'users', uid), adminProfile, { merge: true });
        return adminProfile;
      }

      // 3. Search students collection by email
      if (cleanEmail && cleanEmail.length > 3) {
        try {
          const studentsRef = collection(db, 'students');
          const qStudents = query(studentsRef, where('email', '==', cleanEmail));
          const studSnap = await getDocs(qStudents);
          for (const docItem of studSnap.docs) {
            const studData = docItem.data() as StudentProfile;
            if (studData.email && studData.email.toLowerCase().trim() === cleanEmail) {
              const studentUserProfile: UserProfile = {
                uid,
                name: studData.studentName || auth.currentUser?.displayName || 'Student',
                email: cleanEmail,
                role: 'student',
                createdAt: new Date().toISOString()
              };

              // Save/sync to UID keys
              const updatedStudentProfile: StudentProfile = {
                ...studData,
                studentId: uid,
                uid: uid,
                email: cleanEmail
              };
              await setDoc(doc(db, 'students', uid), updatedStudentProfile, { merge: true });
              await setDoc(doc(db, 'users', uid), studentUserProfile, { merge: true });

              if (docItem.id !== uid) {
                try {
                  await deleteDoc(doc(db, 'students', docItem.id));
                  await deleteDoc(doc(db, 'users', docItem.id));
                } catch (delErr) {
                  console.warn("Notice cleaning old student document ID:", delErr);
                }
              }
              return studentUserProfile;
            }
          }
        } catch (studErr) {
          console.warn("Student email search notice:", studErr);
        }
      }

      // 4. Search staffs collection by email
      if (cleanEmail && cleanEmail.length > 3) {
        try {
          const staffsRef = collection(db, 'staffs');
          const qStaffs = query(staffsRef, where('email', '==', cleanEmail));
          const staffSnap = await getDocs(qStaffs);
          for (const docItem of staffSnap.docs) {
            const staffData = docItem.data() as StaffProfile;
            if (staffData.email && staffData.email.toLowerCase().trim() === cleanEmail) {
              const staffUserProfile: UserProfile = {
                uid,
                name: staffData.fullName || staffData.staffName || auth.currentUser?.displayName || 'Faculty Member',
                email: cleanEmail,
                role: 'staff',
                createdAt: staffData.createdAt || new Date().toISOString()
              };

              const updatedStaffProfile: StaffProfile = {
                ...staffData,
                staffId: staffData.staffId || uid,
                uid: uid,
                email: cleanEmail
              };
              await setDoc(doc(db, 'staffs', uid), updatedStaffProfile, { merge: true });
              await setDoc(doc(db, 'staff', uid), updatedStaffProfile, { merge: true });
              await setDoc(doc(db, 'users', uid), staffUserProfile, { merge: true });

              if (docItem.id !== uid) {
                try {
                  await deleteDoc(doc(db, 'staffs', docItem.id));
                  await deleteDoc(doc(db, 'staff', docItem.id));
                  await deleteDoc(doc(db, 'users', docItem.id));
                } catch (delErr) {
                  console.warn("Notice cleaning old staff document ID:", delErr);
                }
              }
              return staffUserProfile;
            }
          }
        } catch (staffErr) {
          console.warn("Staff email search notice:", staffErr);
        }
      }

      // 5. Search users collection by email (e.g. pre-enrolled or unlinked UID)
      if (cleanEmail && cleanEmail.length > 3) {
        try {
          const usersRef = collection(db, 'users');
          const qUsers = query(usersRef, where('email', '==', cleanEmail));
          const queryUsersSnap = await getDocs(qUsers);
          
          for (const oldUserDoc of queryUsersSnap.docs) {
            const oldData = oldUserDoc.data() as UserProfile;
            if (oldData.email && oldData.email.toLowerCase().trim() === cleanEmail) {
              const oldUid = oldUserDoc.id;
              const newUserProfile: UserProfile = {
                ...oldData,
                uid: uid,
                email: cleanEmail,
                createdAt: oldData.createdAt || new Date().toISOString()
              };
              await setDoc(doc(db, 'users', uid), newUserProfile, { merge: true });
              
              if (oldUid !== uid) {
                if (oldData.role === 'student') {
                  const oldStudRef = doc(db, 'students', oldUid);
                  const oldStudSnap = await getDoc(oldStudRef);
                  if (oldStudSnap.exists()) {
                    const oldStudData = oldStudSnap.data() as StudentProfile;
                    const newStudentProfile: StudentProfile = {
                      ...oldStudData,
                      studentId: uid,
                      uid: uid
                    };
                    await setDoc(doc(db, 'students', uid), newStudentProfile, { merge: true });
                    await deleteDoc(oldStudRef);
                  }
                } else if (oldData.role === 'staff') {
                  const oldStaffRef = doc(db, 'staffs', oldUid);
                  const oldStaffSnap = await getDoc(oldStaffRef);
                  if (oldStaffSnap.exists()) {
                    const oldStaffData = oldStaffSnap.data() as StaffProfile;
                    const newStaffProfile: StaffProfile = {
                      ...oldStaffData,
                      staffId: uid,
                      uid: uid
                    };
                    await setDoc(doc(db, 'staffs', uid), newStaffProfile, { merge: true });
                    await setDoc(doc(db, 'staff', uid), newStaffProfile, { merge: true });
                    await deleteDoc(oldStaffRef);
                  }
                }
                await deleteDoc(doc(db, 'users', oldUid));
              }
              return newUserProfile;
            }
          }
        } catch (migrationErr) {
          console.warn("Failed to migrate pre-enrolled user profile:", migrationErr);
        }
      }
      
      // 6. Safe Auto-Provisioning for Authenticated User
      // If the user is authenticated in Firebase Auth, synthesize the required Firestore profile so they are never locked out
      const isStaffRole = cleanEmail.includes('staff') || cleanEmail.includes('faculty') || cleanEmail.includes('prof');
      const role: 'student' | 'staff' = isStaffRole ? 'staff' : 'student';
      const displayName = auth.currentUser?.displayName || (cleanEmail ? cleanEmail.split('@')[0].replace(/[._]/g, ' ') : 'User');
      const capitalizedName = displayName.charAt(0).toUpperCase() + displayName.slice(1);

      const generatedUserProfile: UserProfile = {
        uid,
        name: capitalizedName,
        email: cleanEmail,
        role,
        createdAt: new Date().toISOString()
      };

      await setDoc(doc(db, 'users', uid), generatedUserProfile, { merge: true });

      if (role === 'student') {
        const generatedStudentProfile: StudentProfile = {
          studentId: uid,
          uid,
          studentName: capitalizedName,
          rollNumber: 'STU-' + uid.slice(0, 6).toUpperCase(),
          department: 'Computer Science',
          year: '1st Year',
          email: cleanEmail,
          faceRegistered: false,
          attendancePercentage: 100,
          photoURL: ""
        };
        await setDoc(doc(db, 'students', uid), generatedStudentProfile, { merge: true });
      } else {
        const generatedStaffProfile: StaffProfile = {
          uid,
          staffId: 'STF-' + uid.slice(0, 6).toUpperCase(),
          fullName: capitalizedName,
          staffName: capitalizedName,
          email: cleanEmail,
          department: 'CSDS',
          assignedClass: 'CSDS - II',
          role: 'staff',
          createdAt: new Date().toISOString()
        };
        await setDoc(doc(db, 'staffs', uid), generatedStaffProfile, { merge: true });
        await setDoc(doc(db, 'staff', uid), generatedStaffProfile, { merge: true });
      }

      console.log(`Auto-healed and provisioned missing profile for ${cleanEmail} (role: ${role})`);
      return generatedUserProfile;
    } catch (err) {
      console.error("Failed to fetch or heal user profile:", err);
      throw err;
    }
  };

  const refreshProfile = async () => {
    if (!currentUser) return;
    try {
      const uProfile = await healMissingUserProfile(currentUser.uid, currentUser.email || '');
      setUserProfile(uProfile);
      await fetchExtendedProfiles(currentUser.uid, uProfile.role);
    } catch (e) {
      console.error("Error refreshing profile:", e);
    }
  };

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      setCurrentUser(user);
      // Immediately reset profile states on any user identity transition to prevent stale/mixed profiles
      setUserProfile(null);
      setStudentProfile(null);
      setStaffProfile(null);

      if (user) {
        if (isAuthActionInProgressRef.current) {
          console.log("Auth action in progress, skipping automatic onAuthStateChanged listener heal");
          return;
        }
        try {
          let uProfile = await fetchProfileByUid(user.uid, user.email || '');
          if (!uProfile) {
            uProfile = await healMissingUserProfile(user.uid, user.email || '');
          }
          setUserProfile(uProfile);
          await fetchExtendedProfiles(user.uid, uProfile.role);
        } catch (error) {
          console.error("Error loading user profile on state change:", error);
          setUserProfile(null);
          setStudentProfile(null);
          setStaffProfile(null);
        }
      }
      setLoading(false);
    });

    return unsubscribe;
  }, []);

  const login = async (email: string, password: string): Promise<UserProfile> => {
    setLoading(true);
    // Clear profile states immediately to avoid displaying previous user's profile
    setUserProfile(null);
    setStudentProfile(null);
    setStaffProfile(null);
    isAuthActionInProgressRef.current = true;
    try {
      const cleanEmail = email.trim().toLowerCase();

      // Handle Admin Sandbox Account
      if (cleanEmail === 'admin@college.com' && password === 'Admin@123') {
        let adminUser: FirebaseUser | null = null;
        try {
          const res = await signInWithEmailAndPassword(auth, cleanEmail, password);
          adminUser = res.user;
        } catch (adminErr: any) {
          // If admin@college.com does not exist in Firebase Auth yet, provision it
          try {
            const res = await createUserWithEmailAndPassword(auth, cleanEmail, password);
            adminUser = res.user;
          } catch (createErr) {
            console.error("Admin sandbox provision note:", createErr);
          }
        }

        const adminUid = adminUser ? adminUser.uid : (auth.currentUser ? auth.currentUser.uid : 'admin_sandbox');
        const adminProfile: UserProfile = {
          uid: adminUid,
          name: 'Administrator',
          email: 'admin@college.com',
          role: 'admin',
          createdAt: new Date().toISOString()
        };

        await setDoc(doc(db, 'users', adminUid), adminProfile, { merge: true });
        setUserProfile(adminProfile);
        setStudentProfile(null);
        setStaffProfile(null);
        return adminProfile;
      }

      let result;
      try {
        result = await signInWithEmailAndPassword(auth, email, password);
      } catch (authError: any) {
        let errorMsg = authError?.message || "Login failed.";
        if (authError.code === 'auth/invalid-email') {
          errorMsg = "Invalid email address format.";
        } else if (authError.code === 'auth/user-not-found') {
          errorMsg = "User not found. No account exists with this email address.";
        } else if (authError.code === 'auth/wrong-password' || authError.code === 'auth/invalid-credential') {
          errorMsg = "Wrong password. Please check your password and try again.";
        } else if (authError.code === 'auth/user-disabled') {
          errorMsg = "This account has been disabled. Please contact support.";
        }
        throw new Error(errorMsg);
      }

      const uid = auth.currentUser ? auth.currentUser.uid : result.user.uid;

      // Check email verification if required
      if (auth.currentUser && auth.currentUser.emailVerified === false && (import.meta.env.VITE_REQUIRE_EMAIL_VERIFICATION === 'true')) {
        throw new Error("Email address is not verified. Please verify your email before logging in.");
      }

      // Fetch Firestore document using auth.currentUser.uid or heal/provision if missing
      let profile = await fetchProfileByUid(uid, email);
      if (!profile) {
        profile = await healMissingUserProfile(uid, email);
      }

      setUserProfile(profile);
      await fetchExtendedProfiles(uid, profile.role);
      return profile;
    } catch (error) {
      setLoading(false);
      throw error;
    } finally {
      isAuthActionInProgressRef.current = false;
      setLoading(false);
    }
  };

  const signUpStudent = async (data: {
    studentName: string;
    rollNumber: string;
    department: string;
    year: string;
    email: string;
    password: string;
  }) => {
    setLoading(true);
    // Clear previous profile state
    setUserProfile(null);
    setStudentProfile(null);
    setStaffProfile(null);
    isAuthActionInProgressRef.current = true;
    let createdUser: FirebaseUser | null = null;
    try {
      // 1. Create the user in Firebase Authentication
      const result = await createUserWithEmailAndPassword(auth, data.email, data.password);
      createdUser = result.user;
      const uid = createdUser.uid;

      // Update Auth Display Name safely
      try {
        await updateProfile(createdUser, {
          displayName: data.studentName
        });
      } catch (profileErr) {
        console.warn("Auth updateProfile notice during student registration:", profileErr);
      }

      const createdAtIso = new Date().toISOString();

      const newUserProfile: UserProfile = {
        uid,
        name: data.studentName,
        email: data.email,
        role: 'student',
        createdAt: createdAtIso
      };

      const newStudentProfile: StudentProfile = {
        studentId: uid,
        uid,
        studentName: data.studentName,
        rollNumber: data.rollNumber,
        department: data.department,
        year: data.year,
        email: data.email,
        faceRegistered: false,
        attendancePercentage: 100,
        photoURL: ""
      };

      // 2. Clean up any pre-enrolled temporary document with the same email in Firestore
      try {
        const cleanEmail = data.email.toLowerCase().trim();
        if (cleanEmail) {
          const oldDocsSnap = await getDocs(query(collection(db, 'students'), where('email', '==', cleanEmail)));
          for (const oldDoc of oldDocsSnap.docs) {
            if (oldDoc.id !== uid) {
              try {
                await deleteDoc(doc(db, 'students', oldDoc.id));
                await deleteDoc(doc(db, 'users', oldDoc.id));
                await deleteDoc(doc(db, 'face_descriptors', oldDoc.id));
              } catch (cleanupErr) {
                console.warn("Notice cleaning old pre-enrollment document during signup:", cleanupErr);
              }
            }
          }
        }
      } catch (checkErr) {
        console.warn("Notice checking old pre-enrollments:", checkErr);
      }

      // 3. Create Firestore documents
      try {
        await setDoc(doc(db, 'users', uid), newUserProfile);
        await setDoc(doc(db, 'students', uid), newStudentProfile);
      } catch (dbErr: any) {
        console.error("Firestore document creation failed. Rolling back user creation in Auth...", dbErr);
        if (createdUser) {
          try {
            await createdUser.delete();
          } catch (delErr) {
            console.error("Auth rollback failed:", delErr);
          }
        }
        throw new Error("Failed to save student profile in database. Registration cancelled.");
      }

      setUserProfile(newUserProfile);
      setStudentProfile(newStudentProfile);
      setStaffProfile(null);
    } catch (error: any) {
      setLoading(false);
      let message = error?.message || "Registration failed.";
      if (error?.code === 'auth/email-already-in-use') {
        message = "This email address is already registered. Please sign in instead.";
      } else if (error?.code === 'auth/invalid-email') {
        message = "Invalid email address format.";
      } else if (error?.code === 'auth/weak-password') {
        message = "Password should be at least 6 characters long.";
      }
      throw new Error(message);
    } finally {
      isAuthActionInProgressRef.current = false;
      setLoading(false);
    }
  };

  const updateStudentProfileDetails = async (details: {
    studentName: string;
    rollNumber: string;
    department: string;
    year: string;
  }) => {
    if (!currentUser) throw new Error("No active session.");
    const uid = currentUser.uid;

    const userDocRef = doc(db, 'users', uid);
    const studentDocRef = doc(db, 'students', uid);

    await setDoc(userDocRef, { name: details.studentName }, { merge: true });
    await setDoc(studentDocRef, {
      studentName: details.studentName,
      rollNumber: details.rollNumber,
      department: details.department,
      year: details.year
    }, { merge: true });

    if (userProfile) {
      setUserProfile({ ...userProfile, name: details.studentName });
    }
    if (studentProfile) {
      setStudentProfile({
        ...studentProfile,
        studentName: details.studentName,
        rollNumber: details.rollNumber,
        department: details.department,
        year: details.year
      });
    }
  };

  const signUpStaff = async (data: {
    fullName: string;
    staffId: string;
    department: string;
    assignedClass: string;
    year?: string;
    email: string;
    password: string;
  }) => {
    setLoading(true);
    isAuthActionInProgressRef.current = true;
    let createdUser: FirebaseUser | null = null;
    try {
      // 1. Create user in Firebase Authentication using createUserWithEmailAndPassword()
      const result = await createUserWithEmailAndPassword(auth, data.email, data.password);
      createdUser = result.user;
      const uid = createdUser.uid;

      // Update Auth Display Name safely
      try {
        await updateProfile(createdUser, {
          displayName: data.fullName
        });
      } catch (profileErr) {
        console.warn("Auth updateProfile notice during staff registration:", profileErr);
      }

      const createdAtIso = new Date().toISOString();
      const finalYear = data.year || getYearFromClass(data.assignedClass);
      const finalClass = data.assignedClass || getClassFromDeptAndYear(data.department, finalYear);

      const newUserProfile: UserProfile = {
        uid,
        name: data.fullName,
        email: data.email,
        role: 'staff',
        createdAt: createdAtIso
      };

      const newStaffProfile: StaffProfile = {
        uid,
        staffId: data.staffId,
        fullName: data.fullName,
        staffName: data.fullName,
        email: data.email,
        department: data.department,
        assignedClass: finalClass,
        year: finalYear,
        academicYear: finalYear,
        role: 'staff',
        createdAt: createdAtIso
      };

      // 2. Create Firestore documents using UID as key
      try {
        await setDoc(doc(db, 'users', uid), newUserProfile);
        await setDoc(doc(db, 'staffs', uid), newStaffProfile);
        await setDoc(doc(db, 'staff', uid), newStaffProfile);
      } catch (dbErr: any) {
        console.error("Firestore document creation failed during staff signup. Rolling back user creation in Auth...", dbErr);
        if (createdUser) {
          try {
            await createdUser.delete();
          } catch (delErr) {
            console.error("Auth rollback failed:", delErr);
          }
        }
        throw new Error("Failed to save staff profile in database. Registration cancelled.");
      }

      setUserProfile(newUserProfile);
      setStaffProfile(newStaffProfile);
      setStudentProfile(null);
    } catch (error: any) {
      setLoading(false);
      let message = error?.message || "Registration failed.";
      if (error?.code === 'auth/email-already-in-use') {
        message = "This email address is already registered. Please sign in instead.";
      } else if (error?.code === 'auth/invalid-email') {
        message = "Invalid email address format.";
      } else if (error?.code === 'auth/weak-password') {
        message = "Password should be at least 6 characters long.";
      }
      throw new Error(message);
    } finally {
      isAuthActionInProgressRef.current = false;
      setLoading(false);
    }
  };

  const logout = async () => {
    setLoading(true);
    try {
      await signOut(auth);
      setUserProfile(null);
      setStudentProfile(null);
      setStaffProfile(null);
    } catch (error) {
      console.error("Error signing out:", error);
    } finally {
      setLoading(false);
    }
  };

  const resetPassword = async (email: string) => {
    const cleanEmail = email.trim().toLowerCase();
    if (!cleanEmail) {
      throw new Error("Please enter your email address to receive a password reset link.");
    }
    try {
      await sendPasswordResetEmail(auth, cleanEmail);
    } catch (err: any) {
      if (err.code === 'auth/user-not-found') {
        throw new Error("No account found with this email address.");
      } else if (err.code === 'auth/invalid-email') {
        throw new Error("Invalid email address format.");
      }
      throw new Error(err.message || "Failed to send password reset email.");
    }
  };

  const value = {
    currentUser,
    userProfile,
    studentProfile,
    staffProfile,
    loading,
    login,
    signUpStudent,
    signUpStaff,
    updateStudentProfileDetails,
    logout,
    refreshProfile,
    resetPassword
  };

  return (
    <AuthContext.Provider value={value}>
      {!loading && children}
    </AuthContext.Provider>
  );
};
