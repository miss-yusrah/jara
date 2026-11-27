// Schools for the campus leaderboard. The list is only suggestions: players can type any school, so
// this never has to be complete. Shared by the server (validation) and the game screen (datalist).
export const CAMPUSES = [
  'UNILAG', 'UI (Ibadan)', 'OAU (Ife)', 'UNN (Nsukka)', 'ABU (Zaria)', 'UNIBEN', 'LASU', 'UNILORIN', 'UNIPORT', 'UNIZIK',
  'UNICAL', 'UNIUYO', 'UNIJOS', 'BUK (Kano)', 'UNIMAID', 'UDUS (Sokoto)', 'UniAbuja', 'FUTA (Akure)', 'FUTO (Owerri)', 'FUT Minna',
  'FUNAAB', 'LAUTECH', 'DELSU', 'EKSU', 'OOU', 'FUOYE', 'KWASU', 'RSU', 'NDU', 'IMSU', 'ABSU', 'ESUT', 'Benue State University',
  'Covenant University', 'Babcock University', 'ABUAD', 'Bowen University', 'Landmark University', 'Redeemer’s University', 'Pan-Atlantic University',
  'American University of Nigeria', 'Yabatech', 'LASUSTECH', 'Auchi Poly', 'The Polytechnic, Ibadan', 'Kaduna Poly',
] as const

/** Accept any school the player types: 2–40 characters, letters/numbers and light punctuation; spaces
 * tidied. Returns the cleaned name, or null if it is empty or has odd characters. */
export function cleanCampus(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const c = value.replace(/\s+/g, ' ').trim()
  if (c.length < 2 || c.length > 40) return null
  return /^[\p{L}\p{N} .,'’&()/-]+$/u.test(c) ? c : null
}
