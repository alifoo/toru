import { z } from "zod";

/**
 * What the live blur keeps legible and what it blurs on top of the defaults.
 *
 * By default every e-mail address on screen is blurred, with the person's name that sits with it, plus telephone
 * numbers and the person columns of a table of contacts. `keepEmailDomains` keeps the addresses of the user's own
 * company legible (a demo of their own inbox), `blurTexts` adds what no pattern can find: lead names in a list that
 * shows no address next to them.
 */
export const PrivacyOptionsSchema = z.object({
  keepEmailDomains: z.array(z.string().trim().toLowerCase().regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/))
    .max(20).optional(),
  blurTexts: z.array(z.string().trim().min(2).max(200)).max(200).optional(),
}).strict();
export type PrivacyOptions = z.infer<typeof PrivacyOptionsSchema>;

/** The options as the page script reads them: domains and texts lower-cased, duplicates and blanks gone. */
export function normalizePrivacyOptions(options: PrivacyOptions | undefined): { keep: string[]; texts: string[] } {
  const parsed = PrivacyOptionsSchema.parse(options ?? {});
  const keep = [...new Set((parsed.keepEmailDomains ?? []).map((domain) => domain.replace(/^\.+|\.+$/g, "")))].filter(Boolean);
  const texts = [...new Set((parsed.blurTexts ?? []).map((text) => text.replace(/\s+/g, " ").toLowerCase()))].filter((text) => text.length >= 2);
  return { keep, texts };
}

/**
 * The page script that blurs contact details, as one statement that works both as a document-start script
 * (Page.addScriptToEvaluateOnNewDocument, before the page's own scripts and before its first paint) and as a
 * WebDriver execute body on the document already open.
 *
 * Every document a recording shows gets it, including the ones a sign-in redirect or a link to another site opens
 * (accounts.google.com, mail.google.com): a script run once on the first page was gone with that page, and the
 * account chooser and the inbox were recorded legible.
 *
 * Nodes are checked as the parser or the app inserts them, inside the MutationObserver callback, which runs before
 * the browser paints the frame they appear in. A full pass then catches what that cannot see cheaply: tables of
 * people, field values and rows whose name arrived before their address.
 *
 * Text is blurred on the smallest element holding it (a table keeps its shape, only the cell goes soft). Where that
 * element is a whole paragraph, only the matched words are covered (a highlight), so a quoted reply stays readable
 * around the address. Nothing is moved or rewritten in the page's DOM: frameworks own those nodes.
 */
export function privacyRedactorScript(options?: PrivacyOptions): string {
  const config = normalizePrivacyOptions(options);
  return `(function(config){
  var key = JSON.stringify(config);
  var existing = window.__toruRedactor;
  if (existing && existing.key === key) { existing.scan(); return; }
  if (existing) existing.reconfigure(config, key); else install();
  function install(){
    var MARK = 'data-toru-blur';
    var FILTER = 'blur(7px)';
    // An address, or a run of digits long enough to be a telephone number. Deliberately blunt: a false positive
    // costs one blurred cell, a false negative publishes somebody's number.
    var EMAIL = /[\\w.!#$%&'*+/=?^\`{|}~-]+@[\\w-]+(?:\\.[\\w-]+)+/g;
    var TELEPHONE = /(?:\\+?\\d[\\d ().-]{7,}\\d)/;
    // Headings that introduce a person rather than a thing, both languages the product ships in.
    var PERSON_HEADING = /^\\s*(nome|name|full name|nome completo|contato|contact|pessoa|person|lead)\\b/i;
    // A person's name as a list row shows it: two to six capitalised words, with the particles names carry.
    var WORD = "\\\\p{Lu}[\\\\p{L}'\\u2019.-]*";
    var PARTICLE = '(?:da|de|do|das|dos|di|du|del|della|der|den|van|von|la|le|y|e)';
    var PERSON = new RegExp('^' + WORD + '(?:\\\\s+(?:' + PARTICLE + '\\\\s+)?' + WORD + '){1,5}$', 'u');
    var EMAIL_ATTRIBUTES = ['email', 'data-email', 'data-identifier', 'data-hovercard-id', 'href'];
    var ROW = 'tr,li,[role=row],[role=listitem],[role=option],[role=link],[role=menuitem],[role=treeitem],[data-identifier]';
    var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, TITLE: 1, HEAD: 1, META: 1, LINK: 1 };
    var SHORT = 160;
    var state = { key: key, config: config, sheet: null, highlight: null };
    var css = '[' + MARK + ']{filter:' + FILTER + '!important}::highlight(toru-redact){color:transparent;background-color:rgba(128,128,128,.6);text-shadow:none}';

    function kept(address){
      var at = address.lastIndexOf('@');
      var domain = address.slice(at + 1).toLowerCase().replace(/\\.+$/, '');
      for (var i = 0; i < state.config.keep.length; i++) {
        var allowed = state.config.keep[i];
        if (domain === allowed || domain.slice(-allowed.length - 1) === '.' + allowed) return true;
      }
      return false;
    }
    function hiddenEmail(text){
      if (!text || text.indexOf('@') < 0) return false;
      EMAIL.lastIndex = 0;
      var match;
      while ((match = EMAIL.exec(text))) if (!kept(match[0])) return true;
      return false;
    }
    function ensureSheet(){
      try {
        if (!state.sheet) { state.sheet = new CSSStyleSheet(); state.sheet.replaceSync(css); }
        if (document.adoptedStyleSheets.indexOf(state.sheet) < 0) document.adoptedStyleSheets = document.adoptedStyleSheets.concat([state.sheet]);
      } catch (error) {
        if (document.documentElement && !document.getElementById('__toru-redact-style')) {
          var style = document.createElement('style'); style.id = '__toru-redact-style'; style.textContent = css;
          document.documentElement.appendChild(style);
        }
      }
      try {
        if (!state.highlight && window.Highlight && window.CSS && CSS.highlights) { state.highlight = new Highlight(); CSS.highlights.set('toru-redact', state.highlight); }
      } catch (error) {}
    }
    function blur(element){
      if (!element || element === document.body || element === document.documentElement || SKIP[element.tagName]) return;
      if (!element.hasAttribute(MARK)) element.setAttribute(MARK, '');
      // Inline too: a stylesheet the page replaces would otherwise take the blur with it.
      if (element.style && element.style.getPropertyValue('filter') !== FILTER) element.style.setProperty('filter', FILTER, 'important');
    }
    function cover(node, from, to){
      if (!state.highlight) { blur(node.parentElement); return; }
      try { var range = document.createRange(); range.setStart(node, from); range.setEnd(node, Math.min(to, node.nodeValue.length)); state.highlight.add(range); }
      catch (error) { blur(node.parentElement); }
    }
    function ownText(element){
      return element.childElementCount === 0 ? (element.textContent || '').replace(/\\s+/g, ' ').trim() : '';
    }
    // The name that goes with a blurred address: in the same row of a list (an account chooser, an inbox), or in
    // the smallest block around the address that holds anything else.
    function blurCompanions(element){
      var row = element.closest(ROW);
      if (row && (row.textContent || '').length > 600) row = null;
      if (!row) {
        var own = (element.textContent || '').length;
        for (var parent = element.parentElement, depth = 0; parent && parent !== document.body && depth < 4; parent = parent.parentElement, depth++) {
          var length = (parent.textContent || '').length;
          if (length > 300) break;
          if (length > own + 2) { row = parent; break; }
        }
      }
      if (!row) return;
      var candidates = [row].concat(Array.prototype.slice.call(row.querySelectorAll('*')));
      for (var i = 0; i < candidates.length; i++) {
        var text = ownText(candidates[i]);
        if (text && text.length <= 60 && PERSON.test(text)) blur(candidates[i]);
      }
    }
    function checkText(node){
      var text = node.nodeValue;
      if (!text || text.length < 2) return;
      var parent = node.parentElement;
      if (!parent || SKIP[parent.tagName]) return;
      var spans = [], email = false, match;
      if (text.indexOf('@') >= 0) {
        EMAIL.lastIndex = 0;
        while ((match = EMAIL.exec(text))) if (!kept(match[0])) { email = true; spans.push([match.index, match.index + match[0].length]); }
      }
      if (state.config.texts.length) {
        var lower = text.toLowerCase().replace(/\\u00a0/g, ' ');
        for (var t = 0; t < state.config.texts.length; t++) {
          var needle = state.config.texts[t];
          for (var at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, at + needle.length)) spans.push([at, at + needle.length]);
        }
      }
      // The parent's whole text only for a candidate: read for every text node, a big container's text made a full
      // pass quadratic on a large page.
      var telephone = text.length <= 200 && TELEPHONE.test(text);
      if (!spans.length && !telephone) return;
      var whole = parent.textContent || '';
      if (telephone && whole.length > 200) telephone = false;
      if (!spans.length && !telephone) return;
      if (whole.length <= SHORT || telephone) blur(parent);
      else for (var s = 0; s < spans.length; s++) cover(node, spans[s][0], spans[s][1]);
      if (email) blurCompanions(parent);
    }
    function checkElement(element){
      if (SKIP[element.tagName]) return;
      for (var i = 0; i < EMAIL_ATTRIBUTES.length; i++) {
        var value = element.getAttribute(EMAIL_ATTRIBUTES[i]);
        if (!value || value.indexOf('@') < 0) continue;
        if (EMAIL_ATTRIBUTES[i] === 'href' && !/^mailto:/i.test(value)) continue;
        if (!hiddenEmail(value)) continue;
        if ((element.textContent || '').length <= 600) blur(element);
        blurCompanions(element);
        return;
      }
      if ((element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') && element.type !== 'password') {
        var field = element.value || '';
        if (hiddenEmail(field) || listed(field)) blur(element);
      }
    }
    function listed(text){
      if (!text || !state.config.texts.length) return false;
      var lower = text.toLowerCase().replace(/\\u00a0/g, ' ');
      for (var i = 0; i < state.config.texts.length; i++) if (lower.indexOf(state.config.texts[i]) >= 0) return true;
      return false;
    }
    function visit(root){
      if (!root) return;
      if (root.nodeType === 3) { checkText(root); return; }
      if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
      if (root.nodeType === 1) { if (SKIP[root.tagName]) return; checkElement(root); }
      var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
        acceptNode: function(node){ return node.nodeType === 1 && SKIP[node.tagName] ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT; },
      });
      for (var node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.nodeType === 3) checkText(node); else checkElement(node);
      }
    }
    // A table holding contact details is a table of people: its person columns go too. Scoped to tables that
    // already matched, because a "Nome" column elsewhere lists spreadsheets.
    function tables(){
      var all = document.querySelectorAll('table');
      for (var i = 0; i < all.length; i++) {
        var table = all[i];
        if (!table.querySelector('[' + MARK + ']')) continue;
        var rows = table.rows, heading = rows[0];
        if (!heading) continue;
        var columns = [];
        for (var c = 0; c < heading.cells.length; c++) if (PERSON_HEADING.test(heading.cells[c].textContent || '')) columns.push(c);
        for (var r = 1; r < rows.length; r++) for (var k = 0; k < columns.length; k++) { var cell = rows[r].cells[columns[k]]; if (cell) blur(cell); }
      }
    }
    function scan(){
      ensureSheet();
      if (state.highlight) state.highlight.clear();
      visit(document.body || document.documentElement);
      var marked = document.querySelectorAll('[' + MARK + ']');
      for (var i = 0; i < marked.length; i++) blur(marked[i]);
      tables();
    }
    var queued = false, last = 0;
    function schedule(){
      if (queued) return;
      queued = true;
      // A full pass at most about once a second; each insertion was already checked as it arrived.
      setTimeout(function(){ queued = false; last = Date.now(); scan(); }, Math.max(150, 1000 - (Date.now() - last)));
    }
    var observer = new MutationObserver(function(records){
      ensureSheet();
      var changed = false;
      for (var i = 0; i < records.length; i++) {
        var record = records[i];
        if (record.type === 'characterData') { checkText(record.target); changed = true; }
        else if (record.type === 'attributes') {
          // The page restyling a blurred element must not take the blur with it.
          if (record.attributeName === 'style') { if (record.target.hasAttribute(MARK)) blur(record.target); }
          else { checkElement(record.target); changed = true; }
        }
        else { for (var j = 0; j < record.addedNodes.length; j++) visit(record.addedNodes[j]); changed = true; }
      }
      if (changed) schedule();
    });
    observer.observe(document, { childList: true, subtree: true, characterData: true, attributes: true,
      attributeFilter: EMAIL_ATTRIBUTES.concat(['value', 'style']) });
    state.scan = scan;
    state.reconfigure = function(next, nextKey){
      state.config = next; state.key = nextKey; existingReset(); scan();
    };
    function existingReset(){
      var marked = document.querySelectorAll('[' + MARK + ']');
      for (var i = 0; i < marked.length; i++) { marked[i].removeAttribute(MARK); if (marked[i].style.getPropertyValue('filter') === FILTER) marked[i].style.removeProperty('filter'); }
      if (state.highlight) state.highlight.clear();
    }
    Object.defineProperty(window, '__toruRedactor', { value: state, configurable: true });
    document.addEventListener('DOMContentLoaded', scan, { once: true });
    setInterval(scan, 2000);
    scan();
  }
})(${JSON.stringify(config)});`;
}
