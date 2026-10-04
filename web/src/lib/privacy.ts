// web/src/lib/privacy.ts — the privacy-mode mask for account e-mail addresses.
//
// Pure, with no imports, so the tests and every caller (templates, transcript HTML) share one mask.

/** Every e-mail-shaped substring becomes its first letter, '•••@', the domain's first letter,
 *  '•••' and the top-level domain. Text with no address comes back unchanged. */
export function maskEmails(text: string): string {
  return text.replace(
    /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9])[A-Za-z0-9.-]*(\.[A-Za-z]{2,})\b/g,
    '$1•••@$2•••$3',
  )
}

/** For a label derived from an address's local part. */
export function maskName(name: string): string {
  return name ? name[0] + '•••' : name
}
