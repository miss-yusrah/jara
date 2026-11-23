// What GoodDollar's face check (goodid.gooddollar.org) reports when it sends
// someone back to Jara. It appends `verified` and, on failure, `reason`, each
// base64-encoded (see useFVRedirect / encodeBase64Params in GoodID's bundle).

function decode(value: string | null): string | null {
  if (!value) return null
  try { return atob(decodeURIComponent(value)) } catch { try { return atob(value) } catch { return value } }
}

export type FvReturn = { ok: boolean; message: string }

/** null when the URL isn't a return from the face check. */
export function fvReturn(search: URLSearchParams): FvReturn | null {
  const kind = search.get('fv')
  if (kind === null) return null
  const verified = decode(search.get('verified'))
  const reason = decode(search.get('reason')) ?? ''
  const firstTime = kind !== 'renew'
  if (verified === 'true')
    return { ok: true, message: firstTime ? 'Face check passed ✅ Connect the same wallet again to finish.' : 'Face check passed ✅ GoodDollar can take a few minutes to update, then Jara resumes your daily claims by itself.' }
  if (verified === null)
    // An older return with no result: say nothing we can't back up.
    return { ok: true, message: firstTime ? 'Welcome back! Connect the same wallet again to finish.' : 'Welcome back! If you finished the face check, GoodDollar can take a few minutes to update.' }
  if (/NotMatch/i.test(reason))
    return { ok: false, message: 'GoodDollar couldn’t match your face to the photo from this wallet’s first verification. Try again in bright, even light, facing the camera straight on, without glasses, a hat or a mask. Only the person who first verified this wallet can pass. If that’s you and it keeps failing, contact GoodDollar support.' }
  if (/Duplicate/i.test(reason))
    return { ok: false, message: 'GoodDollar says your face is already verified on a different wallet. Sign in to Jara the way you did the first time so it opens that wallet, instead of verifying a new one.' }
  if (/NotAllowed|Camera/i.test(reason))
    return { ok: false, message: 'The camera was blocked. Allow camera access for this site in your browser settings, then tap Renew again.' }
  if (/NotSupported|Device|ResourceLoading|Unrecoverable/i.test(reason))
    return { ok: false, message: 'This browser or phone couldn’t run the face check. On iPhone use Safari, on Android use Chrome, or try another phone.' }
  if (/age/i.test(reason))
    return { ok: false, message: 'GoodDollar’s age check didn’t pass. GoodDollar verification is for adults only.' }
  return { ok: false, message: 'The face check wasn’t finished. Tap Renew to try again when you’re ready.' }
}
