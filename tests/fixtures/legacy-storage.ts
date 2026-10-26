/**
 * Simulated localStorage snapshots of the legacy UWE Stunden-App (v27) for migration tests.
 *
 * ALL DATA IS FAKE. Names, personnel numbers, PINs and keys are invented test values.
 * The ECDSA key pair below is a TEST key generated only for these fixtures – it is NOT the
 * production key from uwe-config.js and must never be deployed.
 *
 * Every snapshot is a `Record<string, string>` exactly as `localStorage` would hold it
 * (values are the raw strings, including deliberately corrupt ones).
 * `snapshotMeta` documents what the unchanged legacy app makes of each snapshot; these
 * expectations are verified against the real legacy code in tests/legacy/fixtures.test.ts.
 * Formats are documented in docs/legacy-storage.md.
 */

export type LegacySnapshot = Record<string, string>;

/** Raw entry as stored under uwe_hours_2_<eid> (the legacy app never stores more fields). */
export interface LegacyEntry {
  id?: string;
  date: string;
  start: string;
  end: string;
  pause: number | string;
  note?: string;
}

// ---------------------------------------------------------------------------------------------
// Test credentials (fixtures only)
// ---------------------------------------------------------------------------------------------

/** Public TEST key (would be served as window.UWE_ACCESS_PUBLIC_KEY in a test deployment). */
export interface FixtureJwk {
  kty: string;
  crv: string;
  x: string;
  y: string;
  d?: string;
  ext: boolean;
  key_ops: string[];
}

export const FIXTURE_PUBLIC_JWK: FixtureJwk = {
  "key_ops": [
    "verify"
  ],
  "ext": true,
  "kty": "EC",
  "x": "GIrhODUME3wrcqR2FRwAcelt9ZnNd-nBTJm4nJozPUY",
  "y": "XkSIe0-ORoFZJZKjszzIE4KLIGgGJPYyfPvr3wJ0WtI",
  "crv": "P-256"
};

/** Private TEST key – only to sign additional fixture invites. Never use in production. */
export const FIXTURE_PRIVATE_JWK: FixtureJwk = {
  "key_ops": [
    "sign"
  ],
  "ext": true,
  "kty": "EC",
  "x": "GIrhODUME3wrcqR2FRwAcelt9ZnNd-nBTJm4nJozPUY",
  "y": "XkSIe0-ORoFZJZKjszzIE4KLIGgGJPYyfPvr3wJ0WtI",
  "crv": "P-256",
  "d": "vzT9DdJwGyI0jXmyHBy_dXJSDR7el2XwQxrHl7yKeHA"
};

/** Chef password that decrypts the chef-side fixture envelopes below. */
export const FIXTURE_CHEF_PASSWORD = "Test-Chef-Passwort-2026!";

/** Invite PINs per personnel number (PIN hashes are inside the signed codes). */
export const FIXTURE_PINS = {
  E1001: "40000001",
  E1002: "40000002",
  E1003: "40000003",
  E1004: "40000004",
  E1005: "40000005",
  E1006: "40000006",
  E1007: "40000007",
} as const;

export const FIXTURE_EMPLOYEES = {
  E1001: "Erika Musterfrau",
  E1002: "Max Mustermann",
  E1003: "Lena Beispiel",
  E1004: "Tarik Nachtfahrt",
  E1005: "Sabine Schuljahr",
  E1006: "Kai Kaputt",
  E1007: "Gesperrt Gustav",
} as const;

/** Signed invite codes (payload {v:1,eid,name,exp:"2027-12-31",salt,pinHash}) = value of `uwe_session`. */
export const FIXTURE_INVITE_CODES: Record<keyof typeof FIXTURE_PINS, string> = {
  "E1001": "eyJ2IjoxLCJlaWQiOiJFMTAwMSIsIm5hbWUiOiJFcmlrYSBNdXN0ZXJmcmF1IiwiZXhwIjoiMjAyNy0xMi0zMSIsInNhbHQiOiJBUklqTkVWV1ozaUptcXU4emQ3dkFBIiwicGluSGFzaCI6ImRhNGQ1YTQ5YmY1ZmU3Y2NmZTI5Njk0NTFiZWMwM2MxN2JiOTMwZWI4NWU2YjQ4YmU4MmJiODA1YWZiNTA4YzgifQ.Om0zVPH4ZPFAhEh6MIwYUqFWjus8mjJMBCdx4q8jurAgdlJxuXjklOeE04xwwTLaNFcu7vX0ktL3WSByW_ghFw",
  "E1002": "eyJ2IjoxLCJlaWQiOiJFMTAwMiIsIm5hbWUiOiJNYXggTXVzdGVybWFubiIsImV4cCI6IjIwMjctMTItMzEiLCJzYWx0IjoiQWhNa05VWlhhSG1LbTZ5OXp0X3dBUSIsInBpbkhhc2giOiI5YzZjOWFmOGJkYTYwYWNiNjI5MjI3OWZhMjhkNmFhNzllNjk5MGFiMjU0NzNlOGNkZTM0YjcxMTUyY2YzYzJkIn0.Bl9cfxIcJgiUm1OeYHKWAiICMTWo36F973glThJs5P2c4EAXeM-5fGIaWYtYu2rfbXkemVDGs-aycE46sSFOyQ",
  "E1003": "eyJ2IjoxLCJlaWQiOiJFMTAwMyIsIm5hbWUiOiJMZW5hIEJlaXNwaWVsIiwiZXhwIjoiMjAyNy0xMi0zMSIsInNhbHQiOiJBeFFsTmtkWWFYcUxuSzItei1EeEFnIiwicGluSGFzaCI6IjA2MzJhZmVlNGVkMWFiMzU1Yjc1ODk4MTg2YzcwZDU4MTMyMzc0NDI1NjY5ODhjZTMyNDJiYzI0ODhkYjVjMzUifQ.XFT9VMbEhJej-IJwcpqcYLITi-NBzhRyGMcg4_-gPil2L7aWee-TJQp6okYZZ6qhiyZwWupPeRfhafhzltFoXg",
  "E1004": "eyJ2IjoxLCJlaWQiOiJFMTAwNCIsIm5hbWUiOiJUYXJpayBOYWNodGZhaHJ0IiwiZXhwIjoiMjAyNy0xMi0zMSIsInNhbHQiOiJCQlVtTjBoWmFudU1uYTZfME9IeUF3IiwicGluSGFzaCI6ImJhZTE0Y2Y4YWViMTVkODBlNmFiOTcwNGExNjg5NTE3YmY1NjlhNGI4MjFmMGU2ZGJmZjRiZGMxYmVjYmYwMWMifQ.FYbocVPSTdfac9jBdsp6MvQzgg20OXQqaKZe6YZIg89RTOHwGrkWQ1FbBC2LGEgTla6Ze2pZCQCgVyzh5kG0lg",
  "E1005": "eyJ2IjoxLCJlaWQiOiJFMTAwNSIsIm5hbWUiOiJTYWJpbmUgU2NodWxqYWhyIiwiZXhwIjoiMjAyNy0xMi0zMSIsInNhbHQiOiJCUlluT0VsYWEzeU5ucV9BMGVMekJBIiwicGluSGFzaCI6ImQ3YzU1NzE5ODdmMzc1ZmU0YjBjMzc3ZWMwZDA4MzU3YzZlY2MzZTg3MmY2N2U4NWYzNmU0ZThhYmYyZTAxNGEifQ.4oJoItvv3hnZqzdTfk1ysIwSQa84eXttYlRppreb1hd-o5ry_-bzQPtAEO9RIfM6grxyzPk8oEIlmdQOg8aCuQ",
  "E1006": "eyJ2IjoxLCJlaWQiOiJFMTAwNiIsIm5hbWUiOiJLYWkgS2FwdXR0IiwiZXhwIjoiMjAyNy0xMi0zMSIsInNhbHQiOiJCaGNvT1VwYmJIMk9uN0RCMHVQMEJRIiwicGluSGFzaCI6IjE3ZGI2ODQ3ODc0MGYyNjg2NTZiNjRlNGRmMzZlYmQ3NDBkNjc0OTUyOTg2ZTQwZDI4MTc1NzQxOWMwYTIyZjAifQ.Efl0VVqcQQhxzrRkg9PWi2Z-XThX_r7Et0HEYsVrXY8a__ghIOxkRZNixGcXkaENKe50CHmhDPRF_3sFc-D0Ow",
  "E1007": "eyJ2IjoxLCJlaWQiOiJFMTAwNyIsIm5hbWUiOiJHZXNwZXJydCBHdXN0YXYiLCJleHAiOiIyMDI3LTEyLTMxIiwic2FsdCI6IkJ4Z3BPa3RjYlg2UG9MSEMwLVQxQmciLCJwaW5IYXNoIjoiMDNlOWE1MmEyNWE2YzdjNWQ0MjRkOTUxYWM1ODc0NDEzOGJhYmY0N2E5M2RlMjVlZDIxMjFhZWQ0ZDYxODBiMSJ9.I-T4mLZv40_UUeI8U4U-6X2e4y5PX3-vjruycXlpaurUsiXreM9X3i-NFZir5cUwTAGe2pMzpASGUaQEolVSqQ"
};

const json = (value: unknown): string => JSON.stringify(value);

// ---------------------------------------------------------------------------------------------
// Employee data
// ---------------------------------------------------------------------------------------------

/** E1001 – ordinary current (v27) data: UUID ids, two blocks on one day, work account v2. */
const e1001Entries: LegacyEntry[] = [
  { id: "3f1c2b9e-6a4d-4c1b-9f2e-1a2b3c4d5e01", date: "2026-10-26", start: "08:00", end: "16:00", pause: 30, note: "" },
  { id: "3f1c2b9e-6a4d-4c1b-9f2e-1a2b3c4d5e02", date: "2026-11-02", start: "06:30", end: "14:30", pause: 30, note: "Schülertour Linie 7" },
  { id: "3f1c2b9e-6a4d-4c1b-9f2e-1a2b3c4d5e03", date: "2026-11-03", start: "06:30", end: "14:30", pause: 30, note: "Schülertour Linie 7" },
  { id: "3f1c2b9e-6a4d-4c1b-9f2e-1a2b3c4d5e04", date: "2026-11-04", start: "06:00", end: "09:00", pause: 0, note: "Frühtour" },
  { id: "3f1c2b9e-6a4d-4c1b-9f2e-1a2b3c4d5e05", date: "2026-11-04", start: "12:30", end: "16:00", pause: 0, note: "Rücktour" },
  { id: "3f1c2b9e-6a4d-4c1b-9f2e-1a2b3c4d5e06", date: "2026-11-05", start: "07:00", end: "17:00", pause: 45, note: "Dialysefahrt (Aachen)" },
];
const e1001Account = { version: 2, eid: "E1001", openingMinutes: -6000, startMonth: "2026-09", allocations: { "2026-10": 300, "2026-11": 600 } };

/** E1002 – v2-era data (before 24.10.2026): no ids, one entry per day, never opened v26+ (no account key). */
const e1002Entries: LegacyEntry[] = [
  { date: "2026-10-19", start: "07:00", end: "15:00", pause: 30, note: "" },
  { date: "2026-10-20", start: "07:00", end: "15:30", pause: 30, note: "Krankenfahrt" },
  { date: "2026-10-21", start: "07:15", end: "12:15", pause: 0, note: "" },
  { date: "2026-10-22", start: "07:00", end: "15:00", pause: 30, note: "" },
  { date: "2026-10-23", start: "06:45", end: "16:00", pause: 45, note: "Fortbildung" },
];

/** E1003 – duplicates in every flavour. */
const e1003Entries: LegacyEntry[] = [
  // exact duplicate without id (same fingerprint) -> legacy keeps ONE
  { date: "2026-11-09", start: "08:00", end: "12:00", pause: 0, note: "Doppelt" },
  { date: "2026-11-09", start: "08:00", end: "12:00", pause: 0, note: "Doppelt" },
  // same shift once with id and once without -> legacy keeps BOTH (double counted!)
  { id: "7c9e6679-7425-40de-944b-e07fc1f90a01", date: "2026-11-10", start: "08:00", end: "12:00", pause: 0, note: "" },
  { date: "2026-11-10", start: "08:00", end: "12:00", pause: 0, note: "" },
  // same explicit id, different content -> both kept, second gets a NEW random id on every load
  { id: "7c9e6679-7425-40de-944b-e07fc1f90a02", date: "2026-11-11", start: "08:00", end: "12:00", pause: 0, note: "Original" },
  { id: "7c9e6679-7425-40de-944b-e07fc1f90a02", date: "2026-11-11", start: "13:00", end: "15:00", pause: 0, note: "Gleiche ID" },
  // same explicit id AND same content -> also kept twice
  { id: "7c9e6679-7425-40de-944b-e07fc1f90a03", date: "2026-11-12", start: "09:00", end: "11:00", pause: 0, note: "" },
  { id: "7c9e6679-7425-40de-944b-e07fc1f90a03", date: "2026-11-12", start: "09:00", end: "11:00", pause: 0, note: "" },
  // overlapping entries (possible via backup restore by id) -> stored as is
  { id: "7c9e6679-7425-40de-944b-e07fc1f90a04", date: "2026-11-13", start: "08:00", end: "12:00", pause: 0, note: "" },
  { id: "7c9e6679-7425-40de-944b-e07fc1f90a05", date: "2026-11-13", start: "11:00", end: "13:00", pause: 0, note: "überlappt" },
];

/** E1004 – night shifts, month/year boundaries, cross-day overlap; work account still in version-1 format. */
const e1004Entries: LegacyEntry[] = [
  { id: "a1b2c3d4-0000-4000-8000-000000000401", date: "2026-11-12", start: "22:00", end: "06:00", pause: 30, note: "Nachtdienst" },
  // overlaps the night shift above in real time (05:00–06:00 on 13.11.) – legacy did not detect it
  { id: "a1b2c3d4-0000-4000-8000-000000000402", date: "2026-11-13", start: "05:00", end: "09:00", pause: 0, note: "Anschlussfahrt" },
  { id: "a1b2c3d4-0000-4000-8000-000000000403", date: "2026-11-30", start: "22:00", end: "06:00", pause: 30, note: "Monatswechsel" },
  { id: "a1b2c3d4-0000-4000-8000-000000000404", date: "2026-12-31", start: "20:00", end: "04:00", pause: 30, note: "Silvester" },
  { id: "a1b2c3d4-0000-4000-8000-000000000405", date: "2026-12-05", start: "23:30", end: "00:15", pause: 0, note: "kurz nach Mitternacht" },
  { id: "a1b2c3d4-0000-4000-8000-000000000406", date: "2026-12-06", start: "08:00", end: "12:00", pause: 0, note: "" },
  { id: "a1b2c3d4-0000-4000-8000-000000000407", date: "2026-12-06", start: "21:00", end: "01:00", pause: 0, note: "zweiter Block über Mitternacht" },
];
const e1004AccountV1 = {
  version: 1, eid: "E1004", openingMinutes: -6000, startMonth: "2026-11", initialDeadline: "2027-07-19",
  allocations: { "2026-11": 900, "2026-12": 0 },
};

/** E1005 – snapshot taken in autumn 2027: allocations in two school years (2026/27 and 2027/28). */
const e1005Entries: LegacyEntry[] = [
  { id: "b5000000-0000-4000-8000-000000000501", date: "2027-06-14", start: "07:00", end: "15:30", pause: 30, note: "" },
  { id: "b5000000-0000-4000-8000-000000000502", date: "2027-06-15", start: "07:00", end: "15:30", pause: 30, note: "" },
  { id: "b5000000-0000-4000-8000-000000000503", date: "2027-07-15", start: "07:00", end: "15:30", pause: 30, note: "letzte Schulwoche" },
  { id: "b5000000-0000-4000-8000-000000000504", date: "2027-07-16", start: "07:00", end: "13:00", pause: 30, note: "letzter Schultag" },
  { id: "b5000000-0000-4000-8000-000000000505", date: "2027-07-20", start: "08:00", end: "12:00", pause: 0, note: "Ferienfahrt (nicht anrechenbar)" },
  { id: "b5000000-0000-4000-8000-000000000506", date: "2027-08-16", start: "08:00", end: "12:00", pause: 0, note: "Ferienfahrt" },
  { id: "b5000000-0000-4000-8000-000000000507", date: "2027-09-06", start: "07:00", end: "15:30", pause: 30, note: "neues Schuljahr" },
  { id: "b5000000-0000-4000-8000-000000000508", date: "2027-09-07", start: "07:00", end: "15:30", pause: 30, note: "" },
];
const e1005Account = {
  version: 2, eid: "E1005", openingMinutes: -6000, startMonth: "2026-09",
  allocations: { "2027-06": 900, "2027-07": 480, "2027-09": 600 },
};

/** E1006 – invalid/corrupt entries mixed with valid ones; work account belongs to another eid. */
const e1006Entries: unknown[] = [
  { id: "c6000000-0000-4000-8000-000000000601", date: "2026-11-02", start: "08:00", end: "16:00", pause: 30, note: "gültig" },
  { id: "c6000000-0000-4000-8000-000000000602", date: "02.11.2026", start: "08:00", end: "16:00", pause: 30, note: "falsches Datumsformat" },
  { id: "c6000000-0000-4000-8000-000000000603", date: "2026-11-03", start: "08:00", pause: 30, note: "Ende fehlt" },
  { id: "c6000000-0000-4000-8000-000000000604", date: "2026-11-04", start: "08:00", end: "09:00", pause: 90, note: "Pause länger als Einsatz" },
  { id: "c6000000-0000-4000-8000-000000000605", date: "2026-11-05", start: "25:00", end: "09:00", pause: 0, note: "unmögliche Uhrzeit" },
  { id: "c6000000-0000-4000-8000-000000000606", date: "2026-11-06", start: "08:00", end: "08:00", pause: 0, note: "Beginn = Ende" },
  { id: "c6000000-0000-4000-8000-000000000607", date: "2026-11-09", start: "08:00", end: "12:00", pause: "15", note: "Pause als Text (wird akzeptiert)" },
  { id: "c6000000-0000-4000-8000-000000000608", date: "2026-11-10", start: "08:00", end: "12:00", pause: 7.5, note: "Pause mit Nachkomma" },
  null,
  "kein Objekt",
  { id: "x", date: "2026-11-11", start: "08:00", end: "12:00", pause: 0, note: "zu kurze ID -> neue legacy-ID" },
  // impossible calendar date accepted by the legacy check in Chromium/V8 (see docs/testplan.md)
  { id: "c6000000-0000-4000-8000-000000000609", date: "2026-02-30", start: "08:00", end: "12:00", pause: 0, note: "30. Februar" },
];
const e1006ForeignAccount = { version: 2, eid: "E9999", openingMinutes: -6000, startMonth: "2026-09", allocations: { "2026-11": 60 } };

/** E1007 – revoked employee; hours must survive although the session is no longer valid. */
const e1007Entries: LegacyEntry[] = [
  { id: "d7000000-0000-4000-8000-000000000701", date: "2026-10-27", start: "06:00", end: "14:00", pause: 30, note: "" },
  { id: "d7000000-0000-4000-8000-000000000702", date: "2026-10-28", start: "06:00", end: "11:00", pause: 0, note: "" },
];

/** Test mode (test-mitarbeiter.html): fixed eid TEST001, own hours key, but SAME account key scheme. */
const testModeEntries: LegacyEntry[] = [
  { id: "e8000000-0000-4000-8000-000000000801", date: "2026-11-16", start: "08:00", end: "16:00", pause: 30, note: "Probeeintrag" },
  { id: "e8000000-0000-4000-8000-000000000802", date: "2026-11-17", start: "22:00", end: "06:00", pause: 30, note: "Probenacht" },
];
const testModeAccount = { version: 2, eid: "TEST001", openingMinutes: -6000, startMonth: "2026-09", allocations: { "2026-11": 120 } };

// ---------------------------------------------------------------------------------------------
// Chef side (chef-mobil.html)
// ---------------------------------------------------------------------------------------------

/** uwe_chef_remembered_encrypted_backup_v1: AES-GCM(PBKDF2(password, salt, 250000)) of the private JWK. */
export const FIXTURE_CHEF_BACKUP_ENVELOPE = {
  "app": "UWE Stunden Chef",
  "version": 1,
  "publicJwk": {
    "key_ops": [
      "verify"
    ],
    "ext": true,
    "kty": "EC",
    "x": "GIrhODUME3wrcqR2FRwAcelt9ZnNd-nBTJm4nJozPUY",
    "y": "XkSIe0-ORoFZJZKjszzIE4KLIGgGJPYyfPvr3wJ0WtI",
    "crv": "P-256"
  },
  "salt": "ZHWGl6i5ytvs_Q4fMEFSYw",
  "iv": "ZXaHmKm6y9zt_g8g",
  "secret": "RruO75jUj6C0GdO89abxSE1O0aq5aXfqh0Oxhrg_xu4EIoHauYKjjNLimd0Lvj3YhJ3AJ75_dXFiy4IyhHxxJ-1LcAmmfGPr8BdouylpxltGtPrcZZKaOn59DrHn3HWNdbgyYdakDlqkV6KVTrxm2GdNqS-2L1xo7pSdruLdaEuD1qaF8i7WPsWP3KLwYPvFmD4Jn9oiOwWCcCgmAql6FZ2nayUbPwmdsrJZ78o1tVpULT2NwFv7O4B6IXu9tOmZ8zguNzsP_2e_GtisOfc1aWWwoxbaBIYvX9KNj9Jv"
} as const;

/** Decrypted content of uwe_staff_directory_encrypted_v1 (for assertions). */
export const FIXTURE_STAFF_ROSTER = [
  {
    "name": "Erika Musterfrau",
    "eid": "E1001",
    "exp": "2027-12-31",
    "issuedAt": "2026-10-24T09:00:00.000Z",
    "desiredActive": null,
    "source": "issued"
  },
  {
    "name": "Max Mustermann",
    "eid": "E1002",
    "exp": "2027-12-31",
    "issuedAt": "2026-10-24T09:00:00.000Z",
    "desiredActive": null,
    "source": "issued"
  },
  {
    "name": "Lena Beispiel",
    "eid": "E1003",
    "exp": "2027-12-31",
    "issuedAt": "2026-10-24T09:00:00.000Z",
    "desiredActive": null,
    "source": "issued"
  },
  {
    "name": "Tarik Nachtfahrt",
    "eid": "E1004",
    "exp": "2027-12-31",
    "issuedAt": "2026-10-24T09:00:00.000Z",
    "desiredActive": null,
    "source": "issued"
  },
  {
    "name": "Sabine Schuljahr",
    "eid": "E1005",
    "exp": "2027-12-31",
    "issuedAt": "2026-10-24T09:00:00.000Z",
    "desiredActive": null,
    "source": "issued"
  },
  {
    "name": "Kai Kaputt",
    "eid": "E1006",
    "exp": "2027-12-31",
    "issuedAt": "2026-10-24T09:00:00.000Z",
    "desiredActive": null,
    "source": "issued"
  },
  {
    "name": "Gesperrt Gustav",
    "eid": "E1007",
    "exp": "2027-12-31",
    "issuedAt": "2026-10-24T09:00:00.000Z",
    "desiredActive": null,
    "source": "issued"
  },
  {
    "name": "Altfall Anton",
    "eid": "E0999",
    "exp": null,
    "issuedAt": null,
    "desiredActive": false,
    "source": "manual"
  }
];

const STAFF_SALT = "yNnq+wwdLj9QYXKDlKW2xw==";
const STAFF_DIRECTORY = {
  "version": 1,
  "iv": "ydrr/A0eL0BRYnOE",
  "data": "FgGcEu8GySnPrKxlZidNxDao+efj/nGgQa+fg3tqBo5pNxjiQkH081kJZdOmVawtMvwuYC2R62+XcmqPF8bTeybt7J0huN+4FxwBDt/3cO9agyjFXFJT6/HLcmUOhJ7eOQMGhy23//sk0e6la7HUCaeGjc4YKSFVsFUcH2zH2BgCFlgpz0BIaAqIYaE0IOpydk3Q4YccPXR2WarfeG3vQ5ki/MkR++z4cY+2IYsjDfSPlzTGOMkwlgcYNCBNlUq30Po/sQ22oFMeKa1uQnzbB5TPFMCPYWV2oe7aDfWe5jFSULe6BrUjhn6TjTqEyJanIEejNWQ2lUb4whqZbwApOQs3Er+Ax0AHe01JxEBdeUCghJl9e+WI4bhGxw+Ec8DxY4g+YPXqx9WSwDG8Q2NwL83inY9nN+h1B5sUsQlM0xOdF9/IPGVedc8bZ64mrPFv6kxWR/WKvC4zB+qtd+i4XqJ3VJ37rpkV/jzVjyuU+n2OyE9T1p3qTEicO8CicmmObqIeT30wvnOO2DiLibqxsHyZqCoTqPSzquTkhbruJ36dLUwDfV7n9bvm8VF/tO59fxD86vTU8ria+pdFKlOGEFfr7DVNC5vxw1z1bbHZSItl6fnKfEwO0xh82ytacle8SngqFfTsOgBTOKOWyZbZErsag7u2YPH8RFbKxzY6i+cVDQvjBBcZBQ+XxT0xrVH9sQE4jIQsHbaY7uIHUjMFAbPGP/vfwcuSDdMfs4rcy5lWCk55ZzbBJWEjuHrmDQbUMOXzBj7H5pcD9ClztFanCDfofgEJF1fDOfu+GxYzxKCKNMkfqEYrnxHh/Xh34g3Z+7oljxnundq+E8VMCP/SSCLuciWqWzCP+Axs9YNv5VlNoRmJ7rKeqfKnjGg+vI4UVNVkJftw0KWnxqbj4Cixs+9sOO4/ZcHvLHe7OYBoTj7OJvgJ3pUmC7912tcxnaKBAvzRpfcVgDXJes9ipTnwnZ4380VltuCPnxNNnw58k354y1NTy2GgsMbADDZgzti1t1Kp8KWgBM6TlojduIbx4cAEAFP+VpYR+8fnNz9Ed4PqZVfwOySnZD3UA/yifvIjh6QZ0wnkY1NKugCMlfLVxXByC8N93XYd+g0ETLMSTS2wNDa+ljItzlWO+jBRXSxM936nHtUrUDGgYcbP5JZGKb3j5BeiEWfj9Zr9zt/EyDyihgLqvbFrX/c5ZFjUTF2pDsEVy5EOYb+UOBuW18MwVJhHXrKRDXQt7yP0fOO0W9Fcf/KoHU1Tbt/F2FMGAk53fWXBToIdyOXcDqSfgPqOA6uC2icXLETNtLcwGBV1OnVVk2aQ29itsThrE1X4PuOCfoDPjz0+WWB3O+3aoS4ODAWu+s/i2nw0EfCWSCjbT8Yaj99+MajaEaH9eoULlGuQV81oqqr/MqYOKj0d/HW1LP+aFbiI"
};

// ---------------------------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------------------------

export const snapshots = {
  /** Employee phone, current v27 data, logged in. */
  plainV27: {
    uwe_session: FIXTURE_INVITE_CODES.E1001,
    uwe_hours_2_E1001: json(e1001Entries),
    uwe_arbeitszeitkonto_v1_E1001: json(e1001Account),
  },
  /** Employee phone with v2-era entries without ids (never re-saved since). */
  legacyNoIds: {
    uwe_session: FIXTURE_INVITE_CODES.E1002,
    uwe_hours_2_E1002: json(e1002Entries),
  },
  /** Duplicates of every kind. */
  duplicates: {
    uwe_session: FIXTURE_INVITE_CODES.E1003,
    uwe_hours_2_E1003: json(e1003Entries),
    uwe_arbeitszeitkonto_v1_E1003: json({ version: 2, eid: "E1003", openingMinutes: -6000, startMonth: "2026-09", allocations: {} }),
  },
  /** Midnight shifts and a version-1 work account. */
  midnight: {
    uwe_session: FIXTURE_INVITE_CODES.E1004,
    uwe_hours_2_E1004: json(e1004Entries),
    uwe_arbeitszeitkonto_v1_E1004: json(e1004AccountV1),
  },
  /** Work-account allocations across school years 2026/27 and 2027/28 (snapshot from autumn 2027). */
  twoSchoolYears: {
    uwe_session: FIXTURE_INVITE_CODES.E1005,
    uwe_hours_2_E1005: json(e1005Entries),
    uwe_arbeitszeitkonto_v1_E1005: json(e1005Account),
  },
  /** Invalid entries plus a work account of a different employee. */
  corrupt: {
    uwe_session: FIXTURE_INVITE_CODES.E1006,
    uwe_hours_2_E1006: json(e1006Entries),
    uwe_arbeitszeitkonto_v1_E1006: json(e1006ForeignAccount),
  },
  /** Unparsable JSON (e.g. storage quota hit mid-write). The legacy app shows 0 entries and OVERWRITES on next save. */
  unparsable: {
    uwe_session: FIXTURE_INVITE_CODES.E1006,
    uwe_hours_2_E1006: '[{"id":"c6000000-0000-4000-8000-000000000601","date":"2026-11-02","start":"08:00","end":"16',
    uwe_arbeitszeitkonto_v1_E1006: "{broken",
  },
  /** Test mode data only (test-mitarbeiter.html). */
  testMode: {
    uwe_test_hours_v1_only: json(testModeEntries),
    uwe_arbeitszeitkonto_v1_TEST001: json(testModeAccount),
  },
  /** Chef phone: remembered encrypted key backup + encrypted staff directory (+ chef tried the test app). */
  chefDevice: {
    uwe_chef_remembered_encrypted_backup_v1: json(FIXTURE_CHEF_BACKUP_ENVELOPE),
    uwe_staff_directory_salt_v1: STAFF_SALT,
    uwe_staff_directory_encrypted_v1: json(STAFF_DIRECTORY),
    uwe_test_hours_v1_only: json(testModeEntries.slice(0, 1)),
  },
  /** Shared phone: two employees, session of a revoked employee, holiday caches (current v2 and obsolete v1). */
  sharedDevice: {
    uwe_session: FIXTURE_INVITE_CODES.E1007,
    uwe_hours_2_E1001: json(e1001Entries.slice(0, 2)),
    uwe_arbeitszeitkonto_v1_E1001: json({ ...e1001Account, allocations: { "2026-10": 300 } }),
    uwe_hours_2_E1007: json(e1007Entries),
    uwe_nrw_sommerferien_v2: json({ 2031: { start: "2031-07-14", end: "2031-08-26" } }),
    uwe_nrw_sommerferien_v1: json({ 2031: "2031-07-14" }),
  },
} satisfies Record<string, LegacySnapshot>;

export type SnapshotName = keyof typeof snapshots;

export interface HoursKeyExpectation {
  /** Entries the legacy app shows after normalizeEntries(). */
  validCount: number;
  /** Raw array elements silently dropped by the legacy app. */
  droppedCount: number;
  /** Net minutes per month (by start date) after normalization. */
  netMinutesByMonth: Record<string, number>;
  /** Stable ids the legacy app derives for id-less entries (FNV-1a over date|start|end|pause|note). */
  derivedLegacyIds?: string[];
  /** Number of entries whose id is re-generated randomly on every load (duplicate explicit ids). */
  unstableIdCount?: number;
}

export interface SnapshotMeta {
  description: string;
  /** "Today" at which the snapshot is realistic. */
  asOf: string;
  employeeEid?: string;
  hours?: Record<string, HoursKeyExpectation | "unparsable">;
  /** Result of UweWorkAccount.load(): balance per school year (minutes), or the error the app shows. */
  workAccount?: Record<string, { balances: Record<string, number> } | { error: RegExp }>;
  mustSurviveMigration: string[];
}

export const snapshotMeta: Record<SnapshotName, SnapshotMeta> = {
  plainV27: {
    description: "Normales Mitarbeiterhandy mit aktuellen v27-Daten (UUIDs, zwei Einsätze an einem Tag, Arbeitszeitkonto v2).",
    asOf: "2026-11-20",
    employeeEid: "E1001",
    hours: { uwe_hours_2_E1001: { validCount: 6, droppedCount: 0, netMinutesByMonth: { "2026-10": 450, "2026-11": 1845 } } },
    workAccount: { uwe_arbeitszeitkonto_v1_E1001: { balances: { "2026": -5100 } } },
    mustSurviveMigration: ["alle 6 Einsätze inkl. IDs und Bemerkungen", "Aufteilungen 2026-10 (5 h) und 2026-11 (10 h)", "Sitzung/Personalnummer E1001"],
  },
  legacyNoIds: {
    description: "v2-Altbestand ohne IDs (ein Eintrag pro Tag), Arbeitszeitkonto nie geöffnet.",
    asOf: "2026-10-23",
    employeeEid: "E1002",
    hours: {
      uwe_hours_2_E1002: {
        validCount: 5,
        droppedCount: 0,
        netMinutesByMonth: { "2026-10": 2190 },
        derivedLegacyIds: ["legacy-79r8q4", "legacy-1eodjyu", "legacy-snbh87", "legacy-18vv1yy", "legacy-1q7qujg"],
      },
    },
    workAccount: { uwe_arbeitszeitkonto_v1_E1002: { balances: { "2026": -6000 } } },
    mustSurviveMigration: ["alle 5 Einsätze; IDs deterministisch wie legacy (legacy-<FNV-1a>), damit spätere Backups idempotent importiert werden"],
  },
  duplicates: {
    description: "Duplikate: exakt doppelt ohne ID (1 verworfen), gleiche Schicht mit und ohne ID (doppelt gezählt), doppelte explizite IDs, überlappende Einträge.",
    asOf: "2026-11-20",
    employeeEid: "E1003",
    hours: {
      uwe_hours_2_E1003: {
        validCount: 9,
        droppedCount: 1,
        netMinutesByMonth: { "2026-11": 1680 },
        derivedLegacyIds: ["legacy-1jz4bkt", "legacy-90uwu1"],
        unstableIdCount: 2,
      },
    },
    workAccount: { uwe_arbeitszeitkonto_v1_E1003: { balances: { "2026": -6000 } } },
    mustSurviveMigration: ["keine Stunde verlieren; Duplikate/Überlappungen für Klärung markieren statt still löschen"],
  },
  midnight: {
    description: "Nachtschichten über Monats- und Jahreswechsel, Überschneidung über Mitternacht, Arbeitszeitkonto im Format version 1.",
    asOf: "2027-01-05",
    employeeEid: "E1004",
    hours: { uwe_hours_2_E1004: { validCount: 7, droppedCount: 0, netMinutesByMonth: { "2026-11": 1140, "2026-12": 975 } } },
    workAccount: { uwe_arbeitszeitkonto_v1_E1004: { balances: { "2026": -5100 } } },
    mustSurviveMigration: ["Nachtschichten dem Startdatum zugeordnet (legacy-Regel)", "Konto v1 -> v2 (0-Aufteilung 2026-12 entfällt)"],
  },
  twoSchoolYears: {
    description: "Aufteilungen in zwei Schuljahren (2026/27 und 2027/28), Ferienstunden nicht anrechenbar.",
    asOf: "2027-10-15",
    employeeEid: "E1005",
    hours: {
      uwe_hours_2_E1005: {
        validCount: 8,
        droppedCount: 0,
        netMinutesByMonth: { "2027-06": 960, "2027-07": 1050, "2027-08": 240, "2027-09": 960 },
      },
    },
    workAccount: { uwe_arbeitszeitkonto_v1_E1005: { balances: { "2026": -4620, "2027": -5400 } } },
    mustSurviveMigration: ["Schuljahr 2026/27 bleibt mit -77,00 h abgeschlossen", "2027/28 startet erneut bei -100 h (-90,00 h nach 10 h)"],
  },
  corrupt: {
    description: "Ungültige Einträge gemischt mit gültigen; Arbeitszeitkonto gehört zu fremder Personalnummer.",
    asOf: "2026-11-20",
    employeeEid: "E1006",
    hours: {
      uwe_hours_2_E1006: {
        validCount: 4,
        droppedCount: 8,
        netMinutesByMonth: { "2026-02": 240, "2026-11": 915 },
        derivedLegacyIds: ["legacy-2p2hyi"],
      },
    },
    workAccount: { uwe_arbeitszeitkonto_v1_E1006: { error: /anderen Mitarbeiter/ } },
    mustSurviveMigration: ["Rohdaten unverändert sichern (auch verworfene Elemente)", "Konto NICHT übernehmen, sondern zur Klärung markieren"],
  },
  unparsable: {
    description: "Abgeschnittenes JSON. Legacy zeigt 0 Einträge und überschreibt die Rohdaten beim nächsten Speichern.",
    asOf: "2026-11-20",
    employeeEid: "E1006",
    hours: { uwe_hours_2_E1006: "unparsable" },
    workAccount: { uwe_arbeitszeitkonto_v1_E1006: { error: /JSON/ } },
    mustSurviveMigration: ["Rohstring vor jeder Migration 1:1 sichern; Migration darf nicht mit leerem Bestand weiterschreiben"],
  },
  testMode: {
    description: "Nur Testmodus-Daten (test-mitarbeiter.html).",
    asOf: "2026-11-20",
    hours: { uwe_test_hours_v1_only: { validCount: 2, droppedCount: 0, netMinutesByMonth: { "2026-11": 900 } } },
    workAccount: { uwe_arbeitszeitkonto_v1_TEST001: { balances: { "2026": -5880 } } },
    mustSurviveMigration: ["NICHT als echte Arbeitszeit migrieren (Testdaten)"],
  },
  chefDevice: {
    description: "Chef-Handy: gemerkte verschlüsselte Schlüsselsicherung und verschlüsseltes Mitarbeiterverzeichnis.",
    asOf: "2026-11-20",
    hours: { uwe_test_hours_v1_only: { validCount: 1, droppedCount: 0, netMinutesByMonth: { "2026-11": 450 } } },
    mustSurviveMigration: ["Mitarbeiterverzeichnis (nach Entschlüsselung mit Chef-Passwort) als Stammdaten-Import", "privater Signaturschlüssel wird NICHT migriert"],
  },
  sharedDevice: {
    description: "Geteiltes Gerät: zwei Mitarbeiter, Sitzung eines gesperrten Mitarbeiters, Ferien-Cache v2 und veralteter v1-Cache.",
    asOf: "2026-11-20",
    employeeEid: "E1007",
    hours: {
      uwe_hours_2_E1001: { validCount: 2, droppedCount: 0, netMinutesByMonth: { "2026-10": 450, "2026-11": 450 } },
      uwe_hours_2_E1007: { validCount: 2, droppedCount: 0, netMinutesByMonth: { "2026-10": 750 } },
    },
    workAccount: { uwe_arbeitszeitkonto_v1_E1001: { balances: { "2026": -5700 } } },
    mustSurviveMigration: ["Stunden beider Mitarbeiter getrennt nach Personalnummer", "Stunden des gesperrten E1007 bleiben erhalten"],
  },
}
;

/** Backup files as downloaded by the legacy app ("Backup herunterladen"), formats v2–v4. */
export const legacyBackups = {
  /** v2 (until 24.10.2026): one entry per day, no ids, no work account. */
  v2: json({ app: "UWE Stunden", version: 2, eid: "E1002", name: FIXTURE_EMPLOYEES.E1002, exportedAt: "2026-10-23T18:02:11.000Z", entries: e1002Entries }),
  /** v3 (24.–26.10.2026): entries with ids, several per day, no work account. */
  v3: json({ app: "UWE Stunden", version: 3, eid: "E1001", name: FIXTURE_EMPLOYEES.E1001, exportedAt: "2026-10-25T07:45:00.000Z", entries: e1001Entries.slice(0, 1) }),
  /** v4 (since 26.10.2026): entries + validated work account. */
  v4: json({ app: "UWE Stunden", version: 4, eid: "E1001", name: FIXTURE_EMPLOYEES.E1001, exportedAt: "2026-11-20T09:00:00.000Z", entries: e1001Entries, arbeitszeitkonto: e1001Account }),
  /** v4 from test mode: different app name, only importable into test-mitarbeiter.html. */
  v4Test: json({ app: "UWE Stunden Test", version: 4, eid: "TEST001", name: "Test Mitarbeiter", exportedAt: "2026-11-20T09:00:00.000Z", entries: testModeEntries, arbeitszeitkonto: testModeAccount }),
} as const;

/** Every key prefix/name the legacy apps write (for "nothing forgotten" checks in migration tests). */
export const LEGACY_KEY_PATTERNS: RegExp[] = [
  /^uwe_session$/,
  /^uwe_hours_2_[A-Za-z0-9_-]{1,30}$/,
  /^uwe_arbeitszeitkonto_v1_[A-Za-z0-9_-]{1,30}$/,
  /^uwe_test_hours_v1_only$/,
  /^uwe_nrw_sommerferien_v[12]$/,
  /^uwe_chef_remembered_encrypted_backup_v1$/,
  /^uwe_staff_directory_salt_v1$/,
  /^uwe_staff_directory_encrypted_v1$/,
];
