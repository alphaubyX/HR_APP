'use strict';

/**
 * The database schema, written once and turned into MySQL or SQLite DDL.
 *
 * Column spec: "type[:length][!][=default]"
 *   id        auto-increment primary key
 *   int bool  whole numbers / 0-1 flags
 *   money     DECIMAL(14,2)
 *   num       floating point (hours, coordinates, day fractions)
 *   str:N     short text up to N characters (indexable)
 *   text      long text (JSON blobs, notes)
 *   date      'YYYY-MM-DD'      datetime  'YYYY-MM-DD HH:MM:SS'
 *   "!" means NOT NULL. Every business table carries org_id: one database serves many organizations.
 */

const TABLES = {
  /* -------------------------------------------------- platform & sign-in */
  orgs: {
    cols: {
      id: 'id',
      name: 'str:150!',
      code: 'str:40!', // short unique code, used in URLs and on the attendance machine setup
      legal_name: 'str:200',
      email: 'str:150',
      phone: 'str:50',
      address: 'str:400',
      country: 'str:60',
      currency: 'str:8!=PKR',
      timezone: 'str:60!=Asia/Karachi',
      logo: 'text',
      plan: 'str:30!=trial',
      status: 'str:20!=active', // active | suspended
      max_employees: 'int',
      settings: 'text', // JSON: probation days, leave year, payroll basis, approval chain …
      created_at: 'datetime!',
    },
    indexes: [['code', 'unique']],
  },
  users: {
    cols: {
      id: 'id',
      username: 'str:80!',
      email: 'str:150',
      name: 'str:150!',
      password_hash: 'str:200!',
      is_owner: 'bool!=0', // owner of this server: manages every organization
      active: 'bool!=1',
      last_org_id: 'int',
      last_login_at: 'datetime',
      created_at: 'datetime!',
    },
    indexes: [['username', 'unique'], ['email']],
  },
  // A person can belong to several organizations, with a role and (optionally) an employee record in each.
  memberships: {
    cols: {
      id: 'id',
      user_id: 'int!',
      org_id: 'int!',
      role: 'str:20!=employee', // admin | hr | payroll | employee  (line managers are found from the organogram)
      employee_id: 'int',
      active: 'bool!=1',
      created_at: 'datetime!',
    },
    indexes: [['user_id,org_id', 'unique'], ['org_id'], ['employee_id']],
  },
  sessions: {
    cols: {
      id: 'id',
      token_hash: 'str:64!',
      user_id: 'int!',
      org_id: 'int',
      kind: 'str:10!=web', // web | mobile
      user_agent: 'str:300',
      expires_at: 'datetime!',
      created_at: 'datetime!',
    },
    indexes: [['token_hash', 'unique'], ['user_id']],
  },
  audit_log: {
    cols: {
      id: 'id',
      org_id: 'int',
      user_id: 'int',
      action: 'str:60!',
      entity: 'str:40',
      entity_id: 'int',
      details: 'text',
      ip: 'str:60',
      created_at: 'datetime!',
    },
    indexes: [['org_id,created_at'], ['entity,entity_id']],
  },
  notifications: {
    cols: {
      id: 'id',
      org_id: 'int!',
      user_id: 'int!',
      title: 'str:200!',
      body: 'str:500',
      link: 'str:200',
      read_at: 'datetime',
      created_at: 'datetime!',
    },
    indexes: [['user_id,org_id,read_at']],
  },
  jobs: {
    cols: { id: 'id', name: 'str:80!', last_run_key: 'str:40', last_run_at: 'datetime' },
    indexes: [['name', 'unique']],
  },

  /* ------------------------------------------------------ organization */
  branches: {
    cols: {
      id: 'id',
      org_id: 'int!',
      name: 'str:120!',
      code: 'str:30',
      address: 'str:400',
      lat: 'num',
      lng: 'num',
      radius_m: 'int!=150', // geofence radius for mobile attendance
      active: 'bool!=1',
      created_at: 'datetime!',
    },
    indexes: [['org_id']],
  },
  departments: {
    cols: {
      id: 'id',
      org_id: 'int!',
      name: 'str:120!',
      code: 'str:30',
      parent_id: 'int',
      head_employee_id: 'int',
      color: 'str:20',
      approved_strength: 'int', // sanctioned headcount (null = not set)
      sort: 'int!=0',
      active: 'bool!=1',
      created_at: 'datetime!',
    },
    indexes: [['org_id']],
  },
  sections: {
    cols: {
      id: 'id',
      org_id: 'int!',
      department_id: 'int!',
      name: 'str:120!',
      code: 'str:30',
      head_employee_id: 'int',
      approved_strength: 'int',
      sort: 'int!=0',
      active: 'bool!=1',
      created_at: 'datetime!',
    },
    indexes: [['org_id,department_id']],
  },
  designations: {
    cols: { id: 'id', org_id: 'int!', name: 'str:120!', grade_id: 'int', sort: 'int!=0', active: 'bool!=1' },
    indexes: [['org_id']],
  },
  grades: {
    cols: {
      id: 'id', org_id: 'int!', name: 'str:80!', min_salary: 'money', max_salary: 'money',
      structure_id: 'int', sort: 'int!=0', active: 'bool!=1',
    },
    indexes: [['org_id']],
  },
  shifts: {
    cols: {
      id: 'id',
      org_id: 'int!',
      name: 'str:80!',
      start_time: 'str:5!=09:00',
      end_time: 'str:5!=18:00',
      break_minutes: 'int!=60',
      weekly_off: 'str:20!=6,7', // ISO weekdays off: 1 = Monday … 7 = Sunday
      day_overrides: 'text', // JSON { "5": { "start": "09:00", "end": "13:00" } } e.g. Friday short day
      is_default: 'bool!=0',
      active: 'bool!=1',
    },
    indexes: [['org_id']],
  },
  attendance_policies: {
    cols: { id: 'id', org_id: 'int!', name: 'str:80!', rules: 'text', is_default: 'bool!=0', active: 'bool!=1' },
    indexes: [['org_id']],
  },
  holidays: {
    cols: {
      id: 'id',
      org_id: 'int!',
      holiday_date: 'date!',
      name: 'str:150!',
      kind: 'str:20!=public', // public | exceptional
      // what an exceptional day means: closed (paid day off) | relaxed (no late/short marks) | half_day
      treatment: 'str:20!=closed',
      branch_id: 'int', // null = every branch
      note: 'str:300',
      created_at: 'datetime!',
    },
    indexes: [['org_id,holiday_date']],
  },
  checklist_items: {
    cols: { id: 'id', org_id: 'int!', stage: 'str:20!=onboarding', title: 'str:200!', sort: 'int!=0', active: 'bool!=1' },
    indexes: [['org_id']],
  },

  /* --------------------------------------------------------- employees */
  employees: {
    cols: {
      id: 'id',
      org_id: 'int!',
      emp_code: 'str:30!',
      first_name: 'str:80!',
      last_name: 'str:80',
      father_name: 'str:150',
      gender: 'str:10',
      dob: 'date',
      marital_status: 'str:20',
      national_id: 'str:40',
      email: 'str:150',
      phone: 'str:40',
      address: 'str:400',
      emergency_name: 'str:150',
      emergency_phone: 'str:40',
      emergency_relation: 'str:60',
      photo: 'text', // small data URL
      department_id: 'int',
      section_id: 'int', // a section inside the department
      designation_id: 'int',
      grade_id: 'int',
      branch_id: 'int',
      shift_id: 'int',
      policy_id: 'int', // attendance policy (null = organization default)
      manager_id: 'int', // line manager (the organogram)
      employment_type: 'str:20!=full_time', // full_time | part_time | contract | intern | consultant
      status: 'str:20!=probation', // onboarding | probation | permanent | notice | exited | suspended
      join_date: 'date!',
      probation_days: 'int!=0',
      probation_end: 'date',
      confirmed_on: 'date',
      exit_date: 'date',
      exit_reason: 'str:300',
      payment_method: 'str:10!=bank', // bank | cash | cheque
      bank_name: 'str:100',
      bank_account_title: 'str:150',
      bank_account_no: 'str:60',
      bank_iban: 'str:60',
      tax_number: 'str:40',
      tax_exempt: 'bool!=0',
      remote_attendance: 'str:10!=none', // none | anywhere | geofence
      attendance_required: 'bool!=1', // 0 = not tracked (e.g. directors): no absence deductions
      device_user_id: 'str:30', // enrolment number on the attendance machine
      notes: 'text',
      created_at: 'datetime!',
      updated_at: 'datetime!',
    },
    indexes: [['org_id,emp_code', 'unique'], ['org_id,status'], ['org_id,manager_id'], ['org_id,device_user_id']],
  },
  employee_geofences: {
    cols: { id: 'id', org_id: 'int!', employee_id: 'int!', branch_id: 'int!' },
    indexes: [['employee_id,branch_id', 'unique']],
  },
  employee_events: {
    cols: {
      id: 'id',
      org_id: 'int!',
      employee_id: 'int!',
      event: 'str:30!', // joined | probation_extended | confirmed | transfer | promotion | salary | exit | status | note
      event_date: 'date!',
      title: 'str:200!',
      details: 'text',
      user_id: 'int',
      created_at: 'datetime!',
    },
    indexes: [['employee_id,event_date']],
  },
  employee_checklist: {
    cols: {
      id: 'id', org_id: 'int!', employee_id: 'int!', stage: 'str:20!=onboarding', title: 'str:200!',
      done_at: 'datetime', done_by: 'int', sort: 'int!=0',
    },
    indexes: [['employee_id']],
  },
  employee_documents: {
    cols: {
      id: 'id', org_id: 'int!', employee_id: 'int!', title: 'str:150!', file_name: 'str:200!',
      mime: 'str:100', size: 'int', stored_as: 'str:100!', expires_on: 'date', user_id: 'int', created_at: 'datetime!',
    },
    indexes: [['employee_id']],
  },

  /* ------------------------------------------------------------ salary */
  salary_components: {
    cols: {
      id: 'id',
      org_id: 'int!',
      name: 'str:100!',
      code: 'str:30!', // used in formulas, e.g. BASIC, HOUSE_RENT
      kind: 'str:20!=earning', // earning | deduction | employer (employer contribution, shown for information)
      calc: 'str:20!=fixed', // fixed | percent | formula | remainder
      value: 'num!=0', // default amount (fixed) or percentage (percent)
      percent_of: 'str:30', // a component code, or GROSS
      formula: 'str:500',
      taxable: 'bool!=1',
      attendance_based: 'bool!=1', // reduced for absences, unpaid leave and lates
      prorate: 'bool!=1', // prorated for joiners and leavers
      show_on_payslip: 'bool!=1',
      sort: 'int!=0',
      active: 'bool!=1',
    },
    indexes: [['org_id,code', 'unique']],
  },
  salary_structures: {
    cols: { id: 'id', org_id: 'int!', name: 'str:100!', description: 'str:300', active: 'bool!=1' },
    indexes: [['org_id']],
  },
  structure_lines: {
    cols: {
      id: 'id', org_id: 'int!', structure_id: 'int!', component_id: 'int!',
      calc: 'str:20!=fixed', value: 'num!=0', percent_of: 'str:30', formula: 'str:500', sort: 'int!=0',
    },
    indexes: [['structure_id']],
  },
  // A salary revision: effective from a date. The latest one on or before a payroll period applies.
  employee_salaries: {
    cols: {
      id: 'id', org_id: 'int!', employee_id: 'int!', effective_from: 'date!', gross: 'money!=0',
      structure_id: 'int', reason: 'str:200', user_id: 'int', created_at: 'datetime!',
    },
    indexes: [['employee_id,effective_from']],
  },
  employee_salary_lines: {
    cols: {
      id: 'id', org_id: 'int!', salary_id: 'int!', component_id: 'int!',
      calc: 'str:20!=fixed', value: 'num!=0', percent_of: 'str:30', formula: 'str:500',
    },
    indexes: [['salary_id']],
  },
  tax_slabs: {
    cols: {
      id: 'id', org_id: 'int!', from_amount: 'money!=0', to_amount: 'money', fixed_tax: 'money!=0',
      rate: 'num!=0', // % of the income above from_amount
    },
    indexes: [['org_id']],
  },
  loans: {
    cols: {
      id: 'id', org_id: 'int!', employee_id: 'int!', kind: 'str:20!=loan', amount: 'money!', installment: 'money!',
      start_month: 'str:7!', reason: 'str:300', status: 'str:20!=active', user_id: 'int', created_at: 'datetime!',
    },
    indexes: [['org_id,employee_id']],
  },
  loan_repayments: {
    cols: { id: 'id', org_id: 'int!', loan_id: 'int!', run_id: 'int', month: 'str:7!', amount: 'money!', note: 'str:200', created_at: 'datetime!' },
    indexes: [['loan_id'], ['run_id']],
  },
  // One-off additions and deductions for a month: bonus, arrears, fines, reimbursements …
  adjustments: {
    cols: {
      id: 'id', org_id: 'int!', employee_id: 'int!', month: 'str:7!', kind: 'str:20!=earning', title: 'str:150!',
      amount: 'money!', taxable: 'bool!=1', user_id: 'int', created_at: 'datetime!',
    },
    indexes: [['org_id,month']],
  },

  /* ------------------------------------------------------------- leave */
  leave_types: {
    cols: {
      id: 'id',
      org_id: 'int!',
      name: 'str:80!',
      code: 'str:20!',
      color: 'str:20',
      annual_quota: 'num!=0',
      paid: 'bool!=1',
      carry_forward_max: 'num!=0',
      allow_half_day: 'bool!=1',
      allow_in_probation: 'bool!=0',
      prorate_on_join: 'bool!=1',
      count_off_days: 'bool!=0', // weekends/holidays inside a leave count as leave (sandwich)
      gender: 'str:10!=any',
      min_notice_days: 'int!=0',
      max_days_per_request: 'num',
      allow_negative: 'bool!=0',
      sort: 'int!=0',
      active: 'bool!=1',
    },
    indexes: [['org_id,code', 'unique']],
  },
  leave_ledger: {
    cols: {
      id: 'id', org_id: 'int!', employee_id: 'int!', leave_type_id: 'int!', leave_year: 'int!',
      entry: 'str:20!', // allocation | carry_forward | taken | adjustment | lapse | payroll
      days: 'num!', request_id: 'int', run_id: 'int', note: 'str:200', user_id: 'int', created_at: 'datetime!',
    },
    indexes: [['employee_id,leave_year'], ['org_id,leave_year']],
  },
  leave_requests: {
    cols: {
      id: 'id', org_id: 'int!', employee_id: 'int!', leave_type_id: 'int!', from_date: 'date!', to_date: 'date!',
      half_day: 'str:10!=none', // none | first | second
      days: 'num!', reason: 'str:500', status: 'str:20!=pending', // pending | approved | rejected | cancelled
      chain: 'text', // JSON list of approval steps
      step: 'int!=0', approver_employee_id: 'int', step_since: 'datetime',
      decided_at: 'datetime', created_by: 'int', created_at: 'datetime!',
    },
    indexes: [['org_id,status'], ['employee_id,from_date'], ['approver_employee_id,status']],
  },
  approval_actions: {
    cols: {
      id: 'id', org_id: 'int!', subject: 'str:20!', subject_id: 'int!', step: 'int!=0', action: 'str:20!',
      comment: 'str:500', user_id: 'int', employee_id: 'int', created_at: 'datetime!',
    },
    indexes: [['subject,subject_id']],
  },

  /* -------------------------------------------------------- attendance */
  devices: {
    cols: {
      id: 'id', org_id: 'int!', name: 'str:100!', kind: 'str:20!=adms', // adms (ZKTeco push) | api | agent
      serial_no: 'str:60', branch_id: 'int', api_key_hash: 'str:64', last_seen_at: 'datetime',
      last_stamp: 'str:40', active: 'bool!=1', created_at: 'datetime!',
    },
    indexes: [['serial_no'], ['api_key_hash'], ['org_id']],
  },
  punches: {
    cols: {
      id: 'id',
      org_id: 'int!',
      employee_id: 'int',
      device_user_id: 'str:30',
      punch_time: 'datetime!', // local time of the organization
      direction: 'str:5!=auto', // in | out | auto
      source: 'str:10!', // device | mobile | manual | import
      device_id: 'int',
      lat: 'num',
      lng: 'num',
      accuracy_m: 'num',
      branch_id: 'int',
      distance_m: 'num',
      note: 'str:300',
      dedupe_key: 'str:120!',
      user_id: 'int',
      created_at: 'datetime!',
    },
    indexes: [['dedupe_key', 'unique'], ['org_id,employee_id,punch_time'], ['org_id,device_user_id']],
  },
  attendance_days: {
    cols: {
      id: 'id',
      org_id: 'int!',
      employee_id: 'int!',
      work_date: 'date!',
      status: 'str:20!', // present | half_day | absent | leave | half_leave | holiday | weekend | off | missing | not_employed
      shift_start: 'str:5',
      shift_end: 'str:5',
      first_in: 'datetime',
      last_out: 'datetime',
      punch_count: 'int!=0',
      worked_minutes: 'int!=0',
      late_minutes: 'int!=0',
      early_minutes: 'int!=0',
      short_minutes: 'int!=0',
      overtime_minutes: 'int!=0',
      ot_rate: 'num!=0',
      deduction_days: 'num!=0',
      leave_request_id: 'int',
      leave_paid: 'bool',
      holiday_id: 'int',
      remarks: 'str:300',
      manual: 'bool!=0', // set by HR: processing keeps it as is
      manual_note: 'str:300',
      processed_at: 'datetime!',
    },
    indexes: [['employee_id,work_date', 'unique'], ['org_id,work_date']],
  },
  regularizations: {
    cols: {
      id: 'id', org_id: 'int!', employee_id: 'int!', work_date: 'date!', in_time: 'str:5', out_time: 'str:5',
      reason: 'str:500!', status: 'str:20!=pending', approver_employee_id: 'int', chain: 'text', step: 'int!=0',
      step_since: 'datetime', decided_at: 'datetime', created_by: 'int', created_at: 'datetime!',
    },
    indexes: [['org_id,status'], ['employee_id']],
  },

  /* ----------------------------------------------------------- payroll */
  payroll_runs: {
    cols: {
      id: 'id', org_id: 'int!', month: 'str:7!', period_start: 'date!', period_end: 'date!',
      status: 'str:20!=draft', // draft | processed | approved | paid
      title: 'str:150', notes: 'str:500', totals: 'text', employee_count: 'int!=0',
      created_by: 'int', processed_at: 'datetime', approved_by: 'int', approved_at: 'datetime', paid_at: 'datetime',
      created_at: 'datetime!',
    },
    indexes: [['org_id,month', 'unique']],
  },
  payslips: {
    cols: {
      id: 'id',
      org_id: 'int!',
      run_id: 'int!',
      employee_id: 'int!',
      info: 'text', // JSON snapshot: name, code, department, designation, bank …
      period_days: 'num!=0',
      basis_days: 'num!=0',
      employed_days: 'num!=0',
      present_days: 'num!=0',
      paid_leave_days: 'num!=0',
      unpaid_days: 'num!=0',
      absent_days: 'num!=0',
      half_days: 'num!=0',
      late_count: 'int!=0',
      late_deduction_days: 'num!=0',
      leave_adjusted_days: 'num!=0',
      overtime_hours: 'num!=0',
      gross: 'money!=0', // full monthly salary per contract
      earnings: 'money!=0',
      deductions: 'money!=0',
      net: 'money!=0',
      on_hold: 'bool!=0',
      warnings: 'text',
      created_at: 'datetime!',
    },
    indexes: [['run_id,employee_id', 'unique'], ['org_id,employee_id']],
  },
  payslip_lines: {
    cols: {
      id: 'id', org_id: 'int!', payslip_id: 'int!', kind: 'str:20!', code: 'str:30', name: 'str:150!',
      amount: 'money!', source: 'str:20!', ref_id: 'int', taxable: 'bool!=0', sort: 'int!=0',
    },
    indexes: [['payslip_id']],
  },
};

const MYSQL_TYPES = {
  id: 'INT NOT NULL AUTO_INCREMENT PRIMARY KEY',
  int: 'INT', bool: 'TINYINT(1)', money: 'DECIMAL(14,2)', num: 'DOUBLE', text: 'MEDIUMTEXT', date: 'DATE', datetime: 'DATETIME',
};
const SQLITE_TYPES = {
  id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
  int: 'INTEGER', bool: 'INTEGER', money: 'NUMERIC', num: 'REAL', text: 'TEXT', date: 'TEXT', datetime: 'TEXT',
};

function columnDdl(name, spec, dialect) {
  const m = spec.match(/^(\w+)(?::(\d+))?(!)?(?:=(.*))?$/);
  if (!m) throw new Error(`Bad column spec ${name}: ${spec}`);
  const [, type, len, notNull, def] = m;
  let sqlType;
  if (type === 'str') sqlType = dialect === 'mysql' ? `VARCHAR(${len || 255})` : 'TEXT';
  else sqlType = (dialect === 'mysql' ? MYSQL_TYPES : SQLITE_TYPES)[type];
  if (!sqlType) throw new Error(`Unknown type ${type} for ${name}`);
  if (type === 'id') return `${name} ${sqlType}`;
  let out = `${name} ${sqlType}`;
  if (notNull) out += ' NOT NULL';
  if (def !== undefined) out += /^-?\d+(\.\d+)?$/.test(def) ? ` DEFAULT ${def}` : ` DEFAULT '${def.replace(/'/g, "''")}'`;
  return out;
}

function tableDdl(name, def, dialect) {
  const cols = Object.entries(def.cols).map(([c, s]) => `  ${columnDdl(c, s, dialect)}`);
  const stmts = [];
  if (dialect === 'mysql') {
    const idx = (def.indexes || []).map(([cols, kind], i) =>
      `  ${kind === 'unique' ? 'UNIQUE ' : ''}INDEX ix_${name}_${i} (${cols})`);
    stmts.push(`CREATE TABLE IF NOT EXISTS ${name} (\n${[...cols, ...idx].join(',\n')}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  } else {
    stmts.push(`CREATE TABLE IF NOT EXISTS ${name} (\n${cols.join(',\n')}\n)`);
    (def.indexes || []).forEach(([cols, kind], i) =>
      stmts.push(`CREATE ${kind === 'unique' ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ix_${name}_${i} ON ${name} (${cols})`));
  }
  return stmts;
}

function addColumnDdl(table, column, dialect) {
  return `ALTER TABLE ${table} ADD COLUMN ${columnDdl(column, TABLES[table].cols[column], dialect)}`;
}

module.exports = { TABLES, tableDdl, addColumnDdl, columnDdl };
