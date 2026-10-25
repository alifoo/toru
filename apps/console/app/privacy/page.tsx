import type {Metadata} from 'next';
import {PublicPage} from '../public-landing';

export const metadata:Metadata={title:'Privacy Policy · Toru',description:'What Toru collects, why, who processes it, how long it is kept and your rights.',alternates:{canonical:'https://toru.tools/privacy'}};

export default function PrivacyPage(){
  return <PublicPage>
    <p className="eyebrow">Public beta · effective October 11, 2026</p>
    <h1>Privacy Policy</h1>
    <p>This policy explains how Toru, operated by Alisson Ayres (“we”, “us”), handles personal data when you use the website, the console, the connector your AI agent uses, Toru for Chrome and Toru for Mac. For privacy requests, email <a href="mailto:support@toru.tools">support@toru.tools</a>. See also the <a href="/terms">Terms of Service</a>.</p>

    <h2 id="collect">What we collect</h2>
    <ul>
      <li><b>Account data:</b> your name, e-mail address and sign-in details, and the connections you authorize for your agents (stored as hashed credentials).</li>
      <li><b>Recording requests:</b> the product address, the flow and plan your agent sends, field values it provides, and the brand settings you save.</li>
      <li><b>Recording content:</b> the screens of the product being recorded, page observations used to carry out the flow (such as the page address, visible text and the labels of controls), cursor positions and the steps taken, and the videos and previews we produce. Recorded screens may contain personal data shown by the product.</li>
      <li><b>Paired devices:</b> identifiers for the Chrome browsers and Macs you pair, with their access tokens stored in hashed form.</li>
      <li><b>Billing:</b> plan, invoices and payment status. Card details are handled by our payment provider and never reach us.</li>
      <li><b>Usage and diagnostics:</b> credit usage, request and error logs, and failure reports you choose to send.</li>
      <li><b>Support:</b> messages and feedback you send us.</li>
    </ul>

    <h2 id="use">How we use it</h2>
    <p>We use this data to run, recover and deliver your recordings, check videos before delivery, apply your brand, manage accounts, credits and billing, prevent abuse and keep the Service secure, answer support and privacy requests, and meet legal obligations. Our legal bases are performing our contract with you, our legitimate interest in operating and securing the Service, your consent where we ask for it, and legal obligations. We do not sell personal data or recording content, and we do not use it for advertising.</p>

    <h2 id="passwords">Passwords and sign-in</h2>
    <p>Your agent never needs your product password and is only shown the product address. Toru records in your own Chrome or on your Mac, where you are already signed in, and never asks for a password or a sign-in code. A sign-in form appearing during a recording stops the recording instead of being recorded.</p>

    <h2 id="processors">Who processes it</h2>
    <p>We share data only with service providers that help us operate Toru, under agreements that limit their use to providing their service to us:</p>
    <ul>
      <li>an authentication provider, for sign-in and account sessions;</li>
      <li>cloud hosting and storage providers, for running the Service and storing recordings;</li>
      <li>a payment processor (Stripe), for checkout, invoices and refunds;</li>
      <li>AI model providers, which receive page observations from the recording and the instructions your agent sent, to decide the next step of a recording.</li>
    </ul>
    <p>Your own AI agent and its provider process your prompts and what Toru returns under their own terms. We may disclose data when required by law or to protect rights and safety. A current list of providers is available on request.</p>

    <h2 id="retention">How long we keep it</h2>
    <p>On the Free plan we keep raw captures for up to 24 hours and delivered MP4s for up to 7 days; paid plans keep MP4s for 30 days. You can delete recordings in the console. Account, billing, security and operational records may be kept longer where needed to operate the Service, resolve disputes or meet legal duties. Backups are deleted on their own schedule after data is removed from active systems.</p>

    <h2 id="rights">Your rights</h2>
    <p>Depending on where you live, you may have the right to access, correct, delete, export or restrict the use of your personal data, to object to processing, and to withdraw consent. You can revoke agent connections and request account deletion in the console, or email us. We may need to verify that you own the account. You can also complain to your local data protection authority.</p>

    <h2 id="cookies">Cookies</h2>
    <p>We use Vercel Web Analytics to count page views, referrers and clicks on our site; it sets no cookies and does not identify you. We use only cookies needed to keep you signed in and to secure the Service, and store small display preferences in your browser. We do not use advertising or third-party analytics cookies.</p>

    <h2 id="transfers">International transfers</h2>
    <p>Our providers may process data in countries other than yours. Where required, we rely on appropriate safeguards for these transfers.</p>

    <h2 id="security">Security</h2>
    <p>We encrypt data in transit, hash access tokens, limit access to what is needed to run the Service, and keep raw recordings for short periods. No system is perfectly secure; tell us at support@toru.tools if you find a vulnerability.</p>

    <h2 id="children">Children</h2>
    <p>Toru is not intended for anyone under 18, and we do not knowingly collect their personal data.</p>

    <h2 id="mac">Toru for Mac</h2>
    <p>The Mac app records one window or display that you choose, only after you approve it, and saves the video on your Mac in Movies/Toru. The finished video is uploaded for rendering and delivery when a recording you approved stops, or when you choose Retry upload or Record now. Desktop recordings are not redacted: anything visible in the shared window or display, including notifications, is uploaded as recorded, so close private content first. Local copies stay on your Mac until you delete them. Pairing identifies your Mac to your account and never starts a recording by itself; you can disconnect a Mac in the console or the app. Failure reports are off by default and contain only event names, error codes and app versions.</p>

    <h2 id="chrome">Toru for Chrome</h2>
    <p>The Chrome extension lets Toru record in your own browser. For each recording your agent requests, it opens a new window on the requested product and controls only that window until the recording ends, following the demo to the pages it visits; Chrome shows a notice while it does. It does not read or control your other tabs. Your passwords, cookies and browser storage stay in Chrome and are never sent to Toru. During a recording it sends Toru the video of that window, cursor positions, the steps taken and the page observations described above. A password or one-time-code field stops the recording. Pairing stores an access token in the extension and a hashed copy with your account; disconnect from the extension menu, through your agent, or by removing the extension. The extension uses this data only to produce your recordings.</p>

    <h2 id="changes">Changes</h2>
    <p>We will post updates here and notify you of material changes before they apply.</p>

    <h2 id="contact">Contact</h2>
    <p>Privacy requests and questions: <a href="mailto:support@toru.tools">support@toru.tools</a>.</p>
  </PublicPage>;
}
