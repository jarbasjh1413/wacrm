/**
 * Sanitize phone number for Meta WhatsApp API.
 * Meta requires digits only — no + prefix, no spaces, no dashes.
 * e.g. "+370 63949836" → "37063949836"
 */
export function sanitizePhoneForMeta(phone: string): string {
  if (!phone) return ''
  return phone.replace(/\D/g, '')
}

/**
 * Normalize phone number by removing all non-digit characters.
 * Used for comparing phone numbers in different formats.
 */
export function normalizePhone(phone: string): string {
  if (!phone) return ''
  return phone.replace(/\D/g, '')
}

/**
 * Compare two phone numbers accounting for trunk prefix differences.
 * e.g. "370063949836" (with trunk 0) matches "37063949836" (without trunk 0)
 * by comparing the last 8 digits.
 */
export function phonesMatch(phone1: string, phone2: string): boolean {
  const n1 = normalizePhone(phone1)
  const n2 = normalizePhone(phone2)
  if (n1 === n2) return true
  if (n1.length >= 8 && n2.length >= 8) {
    return n1.slice(-8) === n2.slice(-8)
  }
  return false
}

/**
 * Validate phone number is E.164-like format (7-15 digits starting with non-zero).
 * Accepts with or without + prefix.
 */
export function isValidE164(phone: string): boolean {
  return /^\+?[1-9]\d{6,14}$/.test(phone)
}

/**
 * Brazilian ninth-digit variant (CLAUDE.md §6.6).
 *
 * Brazilian mobiles migrated from 8 to 9 subscriber digits by
 * prefixing a "9": +55 DD 9XXXX-XXXX. Old address books (and some
 * WhatsApp JIDs!) still carry the 8-digit form, so the same person can
 * exist both ways. In international digits-only form:
 *   55 + DDD(2) + 9 + 8 digits (13 total) → current mobile
 *   55 + DDD(2) + 8 digits (12 total)     → legacy mobile or landline
 *
 * Returns the counterpart form, or null when the number isn't a
 * Brazilian mobile (landlines start 2-5 and never gained a 9).
 */
export function brazilNinthDigitVariant(sanitized: string): string | null {
  if (!sanitized.startsWith('55')) return null
  // 13 digits with the '9' prefix and a mobile-range digit after it →
  // drop the 9.
  if (
    sanitized.length === 13 &&
    sanitized[4] === '9' &&
    /[6-9]/.test(sanitized[5])
  ) {
    return sanitized.slice(0, 4) + sanitized.slice(5)
  }
  // 12 digits starting in the mobile range → insert the 9.
  if (sanitized.length === 12 && /[6-9]/.test(sanitized[4])) {
    return sanitized.slice(0, 4) + '9' + sanitized.slice(4)
  }
  return null
}

/**
 * Generate plausible phone number variants for retry when Meta's
 * sandbox rejects a number with error #131030 ("not in allowed list").
 *
 * Many countries use a "trunk prefix" 0 for domestic dialing that is
 * meant to be dropped in international format (e.g. Lithuanian
 * "+370 063 949 836" domestically → "+370 63 949 836" international).
 * But some sandboxes register the number with the trunk 0 included,
 * causing sends to the correct international format to fail.
 *
 * This helper yields up to 3 variants:
 *   1. The original sanitized number (first attempt)
 *   2. With a trunk 0 inserted after the country code
 *   3. With a trunk 0 removed after the country code
 *
 * Country-code lengths of 1, 2, and 3 digits are tried because we
 * don't know the user's country ahead of time.
 *
 * @param sanitized - digits-only phone number (from sanitizePhoneForMeta)
 * @returns deduplicated list of variants, original first
 */
export function phoneVariants(sanitized: string): string[] {
  if (!sanitized) return []
  const seen = new Set<string>()
  const push = (v: string) => {
    if (v && !seen.has(v)) seen.add(v)
  }

  // 1. Original
  push(sanitized)

  // 1b. Brazilian ninth-digit counterpart (highest-value retry for a
  // Brazilian deployment, so it goes right after the original).
  const brVariant = brazilNinthDigitVariant(sanitized)
  if (brVariant) push(brVariant)

  // 2. Insert a 0 after each plausible country-code length
  for (const ccLen of [1, 2, 3]) {
    if (sanitized.length <= ccLen) continue
    const cc = sanitized.slice(0, ccLen)
    const rest = sanitized.slice(ccLen)
    if (!rest.startsWith('0')) {
      push(cc + '0' + rest)
    }
  }

  // 3. Remove a leading 0 after each plausible country-code length
  for (const ccLen of [1, 2, 3]) {
    if (sanitized.length <= ccLen + 1) continue
    const cc = sanitized.slice(0, ccLen)
    const rest = sanitized.slice(ccLen)
    if (rest.startsWith('0')) {
      push(cc + rest.slice(1))
    }
  }

  return [...seen]
}

/**
 * Returns true when the Meta API error indicates the recipient
 * phone number isn't in the allowed list (sandbox restriction).
 * Detected via error code 131030 or the standard error text.
 */
export function isRecipientNotAllowedError(message: string): boolean {
  return /131030|not in allowed list|not in the allowed list/i.test(message)
}

/**
 * Returns true when an Evolution API send error indicates the target
 * number has no WhatsApp account — the signal to retry with another
 * phone variant (e.g. the Brazilian ninth-digit counterpart).
 * Evolution/Baileys phrase this a few ways across versions, e.g.
 * '"exists": false', "number does not exist on WhatsApp".
 */
export function isNumberNotOnWhatsAppError(message: string): boolean {
  return /exists["']?\s*:\s*false|not\s+(?:a\s+)?(?:valid\s+)?whatsapp|(?:number|jid).*(?:does\s*n[o']t|not)\s+exist|no\s+account\s+on\s+whatsapp/i.test(
    message
  )
}
