/**
 * Whether the recorded page is a sign-in screen, checked before and after every page action in the user's
 * own Chrome (extension) and the companion window. Runs in the page; only a boolean leaves it.
 *
 * A visible password or one-time-code field means sign-in, except a masked field that is labelled as an
 * API key, token or secret: settings pages mask those like passwords, and an empty one is not a login.
 */
export function signInField(input: {
  type: string;
  autocomplete: string;
  name: string;
  id: string;
  ariaLabel: string;
  placeholder: string;
}): boolean {
  const autocomplete = (input.autocomplete || '').toLowerCase();
  if (/one-time-code|current-password/.test(autocomplete)) return true;
  if (input.type !== 'password' && !/password/.test(autocomplete)) return false;
  const label = [input.name, input.id, input.ariaLabel, input.placeholder].join(' ');
  return !/api[\s_-]?key|apikey|access[\s_-]?key|secret|token|webhook/i.test(label);
}

const fieldCheck = `
const signInField=${signInField.toString()};
const visible=e=>!!(e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden');
const field=e=>signInField({type:e.type||'',autocomplete:e.autocomplete||'',name:e.name||'',id:e.id||'',ariaLabel:e.getAttribute('aria-label')||'',placeholder:e.placeholder||''});
function privateRoot(root){
 for(const e of root.querySelectorAll('input'))if(visible(e)&&field(e))return true;
 for(const e of root.querySelectorAll('*'))if(e.shadowRoot&&privateRoot(e.shadowRoot))return true;
 for(const frame of root.querySelectorAll('iframe')){try{if(frame.contentDocument&&privateRoot(frame.contentDocument))return true;}catch{}}
 return false;
}
`;

/** The product's own pages: a sign-in path or a sign-in field. */
export const privatePageScript = `${fieldCheck}
return /(^|\\/)(sign-in|signin|sign-up|signup|login|entrar|oauth|authorize|factor-one|factor-two)(\\/|$)/i.test(location.pathname)||privateRoot(document);`;

/** Other sites the demo visits: only a visible sign-in field (a consent screen may live under /signin/oauth). */
export const privateFieldsScript = `${fieldCheck}
return privateRoot(document);`;
