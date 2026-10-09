import { PeriodInfo, TimetableStatusResult } from '../types';

export const COLLEGE_TIMETABLE: PeriodInfo[] = [
  {
    periodNumber: 1,
    name: 'Period 1',
    startTime: '09:00',
    endTime: '09:55',
    formattedRange: '9:00 AM - 9:55 AM',
    isLunch: false,
  },
  {
    periodNumber: 2,
    name: 'Period 2',
    startTime: '09:55',
    endTime: '10:50',
    formattedRange: '9:55 AM - 10:50 AM',
    isLunch: false,
  },
  {
    periodNumber: 3,
    name: 'Period 3',
    startTime: '10:50',
    endTime: '11:45',
    formattedRange: '10:50 AM - 11:45 AM',
    isLunch: false,
  },
  {
    periodNumber: 0,
    name: 'Lunch Break',
    startTime: '11:45',
    endTime: '12:40',
    formattedRange: '11:45 AM - 12:40 PM',
    isLunch: true,
  },
  {
    periodNumber: 4,
    name: 'Period 4',
    startTime: '12:40',
    endTime: '13:35',
    formattedRange: '12:40 PM - 1:35 PM',
    isLunch: false,
  },
  {
    periodNumber: 5,
    name: 'Period 5',
    startTime: '13:35',
    endTime: '14:30',
    formattedRange: '1:35 PM - 2:30 PM',
    isLunch: false,
  },
];

export const COLLEGE_START_MINUTES = 9 * 60; // 09:00 -> 540 min
export const COLLEGE_END_MINUTES = 14 * 60 + 30; // 14:30 -> 870 min

/**
 * Converts "HH:MM" string to minutes from midnight
 */
export const timeStringToMinutes = (timeStr: string): number => {
  const parts = timeStr.split(':');
  const hours = parseInt(parts[0], 10);
  const minutes = parseInt(parts[1], 10);
  return hours * 60 + minutes;
};

/**
 * Determines current timetable state and period based on real time or optional simulated minute override.
 */
export const getCurrentTimetableStatus = (
  now: Date = new Date(),
  simulatedPeriodOverride?: number | null
): TimetableStatusResult => {
  const timeString12 = now.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });

  // If testing override is selected (1-5 or -1 for lunch)
  if (simulatedPeriodOverride !== undefined && simulatedPeriodOverride !== null && simulatedPeriodOverride !== 0) {
    if (simulatedPeriodOverride === -1) {
      return {
        state: 'lunch_break',
        period: null,
        message: 'Lunch Break — Period Attendance is Closed.',
        currentTimeString: timeString12,
      };
    }
    const targetPeriod = COLLEGE_TIMETABLE.find(
      (p) => !p.isLunch && p.periodNumber === simulatedPeriodOverride
    );
    if (targetPeriod) {
      return {
        state: 'in_period',
        period: targetPeriod,
        message: `${targetPeriod.name} Active (${targetPeriod.formattedRange})`,
        currentTimeString: timeString12,
      };
    }
  }

  const currentMinutes = now.getHours() * 60 + now.getMinutes();

  // Before 9:00 AM
  if (currentMinutes < COLLEGE_START_MINUTES) {
    return {
      state: 'before_college',
      period: null,
      message: 'Attendance has not started.',
      nextPeriod: COLLEGE_TIMETABLE[0],
      currentTimeString: timeString12,
    };
  }

  // After 2:30 PM
  if (currentMinutes >= COLLEGE_END_MINUTES) {
    return {
      state: 'after_college',
      period: null,
      message: "Today's Period Attendance is Closed.",
      nextPeriod: null,
      currentTimeString: timeString12,
    };
  }

  // Check which slot in timetable matches
  for (let i = 0; i < COLLEGE_TIMETABLE.length; i++) {
    const slot = COLLEGE_TIMETABLE[i];
    const startM = timeStringToMinutes(slot.startTime);
    const endM = timeStringToMinutes(slot.endTime);

    if (currentMinutes >= startM && currentMinutes < endM) {
      if (slot.isLunch) {
        return {
          state: 'lunch_break',
          period: null,
          message: 'Lunch Break — Period Attendance is Closed.',
          nextPeriod: COLLEGE_TIMETABLE.find((p) => p.periodNumber === 4) || null,
          currentTimeString: timeString12,
        };
      } else {
        const nextActive = COLLEGE_TIMETABLE.slice(i + 1).find((p) => !p.isLunch) || null;
        return {
          state: 'in_period',
          period: slot,
          message: `${slot.name} Active (${slot.formattedRange})`,
          nextPeriod: nextActive,
          currentTimeString: timeString12,
        };
      }
    }
  }

  return {
    state: 'after_college',
    period: null,
    message: "Today's Period Attendance is Closed.",
    currentTimeString: timeString12,
  };
};
