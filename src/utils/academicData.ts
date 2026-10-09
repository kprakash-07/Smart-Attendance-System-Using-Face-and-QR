import { StudentProfile } from '../types';

export interface DepartmentOption {
  id: string;
  code: string;
  name: string;
}

export const ACADEMIC_DEPARTMENTS: DepartmentOption[] = [
  { id: 'CS', code: 'CS', name: 'Computer Science (CS)' },
  { id: 'CSDS', code: 'CSDS', name: 'Computer Science with Data Science (CSDS)' },
  { id: 'CSAI', code: 'CSAI', name: 'Computer Science with Artificial Intelligence (CSAI)' },
  { id: 'BCA', code: 'BCA', name: 'BCA' },
  { id: 'B.Com', code: 'B.Com', name: 'B.Com' },
  { id: 'English', code: 'English', name: 'English' },
  { id: 'Mathematics', code: 'Mathematics', name: 'Mathematics' },
  { id: 'Physics', code: 'Physics', name: 'Physics' },
  { id: 'Chemistry', code: 'Chemistry', name: 'Chemistry' },
];

export const CLASS_LEVELS = ['I', 'II', 'III'];

// Helper to get list of classes for a given department
export const getClassesForDepartment = (deptCodeOrId: string): string[] => {
  const code = getDeptCode(deptCodeOrId);
  return CLASS_LEVELS.map(level => `${code} - ${level}`);
};

export const ALL_ACADEMIC_CLASSES: string[] = ACADEMIC_DEPARTMENTS.flatMap(d => 
  CLASS_LEVELS.map(level => `${d.code} - ${level}`)
);

export const getDeptCode = (deptStr: string): string => {
  if (!deptStr) return 'CS';
  const str = deptStr.trim();
  const lower = str.toLowerCase();
  if (lower.includes('data') || lower === 'cs_ds' || lower === 'csds') return 'CSDS';
  if (lower.includes('ai') || lower === 'cs_ai' || lower === 'csai') return 'CSAI';
  if (lower.includes('bca')) return 'BCA';
  if (lower.includes('bcom') || lower.includes('b.com')) return 'B.Com';
  if (lower.includes('english')) return 'English';
  if (lower.includes('mathematics') || lower.includes('math')) return 'Mathematics';
  if (lower.includes('physics')) return 'Physics';
  if (lower.includes('chemistry')) return 'Chemistry';
  if (lower.includes('computer') || lower === 'cs' || lower === 'cse') return 'CS';
  
  const found = ACADEMIC_DEPARTMENTS.find(d => d.id.toLowerCase() === lower || d.code.toLowerCase() === lower || d.name.toLowerCase() === lower);
  if (found) return found.code;

  return str.toUpperCase();
};

export const getDeptName = (deptStr: string): string => {
  const code = getDeptCode(deptStr);
  const found = ACADEMIC_DEPARTMENTS.find(d => d.code === code);
  return found ? found.name : deptStr;
};

// Maps Roman numeral or Year string to standardized "1st Year", "2nd Year", "3rd Year"
export const getYearFromClass = (clsOrYear?: string): string => {
  if (!clsOrYear) return '1st Year';
  const str = clsOrYear.toString().trim();
  const lower = str.toLowerCase();
  if (str.endsWith('- III') || str.endsWith(' III') || lower.includes('3rd') || lower.includes('third') || lower.endsWith('iii')) {
    return '3rd Year';
  }
  if (str.endsWith('- II') || str.endsWith(' II') || lower.includes('2nd') || lower.includes('second') || lower.endsWith('ii')) {
    return '2nd Year';
  }
  if (str.endsWith('- I') || str.endsWith(' I') || lower.includes('1st') || lower.includes('first') || lower.endsWith('i')) {
    return '1st Year';
  }
  return '1st Year';
};

// Returns standard Roman numeral ('I', 'II', 'III') for a year or class string
export const getRomanYear = (yearStr?: string): string => {
  const y = getYearFromClass(yearStr);
  if (y === '3rd Year') return 'III';
  if (y === '2nd Year') return 'II';
  return 'I';
};

// Returns standard class string like "CS - I" given department and year/class
export const getClassFromDeptAndYear = (dept: string, yearOrClass: string): string => {
  const deptCode = getDeptCode(dept);
  const roman = getRomanYear(yearOrClass);
  return `${deptCode} - ${roman}`;
};

// Returns standard class string like "CSDS - II" for any student record
export const getStudentAssignedClass = (s: StudentProfile): string => {
  if (!s) return 'CS - I';
  if ((s as any).assignedClass) return (s as any).assignedClass;

  const deptCode = getDeptCode(s.department || '');
  
  const y = (s.year || '').toString().toLowerCase();
  let yearCode = 'I';
  if (y.includes('2') || y.includes('ii') || y.includes('second')) yearCode = 'II';
  else if (y.includes('3') || y.includes('iii') || y.includes('third')) yearCode = 'III';

  return `${deptCode} - ${yearCode}`;
};
