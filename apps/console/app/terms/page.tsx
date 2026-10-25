import type {Metadata} from 'next';
import {PublicPage} from '../public-landing';

export const metadata:Metadata={title:'Terms of Service · Toru',description:'The terms for using Toru, its plans, credits and refunds.',alternates:{canonical:'https://toru.tools/terms'}};

export default function TermsPage(){
  return <PublicPage>
    <p className="eyebrow">Public beta · effective October 11, 2026</p>
    <h1>Terms of Service</h1>
    <p>These terms govern your use of Toru, including the website, the console at app.toru.tools, the connector your AI agent uses, Toru for Chrome and Toru for Mac (together, the “Service”). Toru is operated by Alisson Ayres (“we”, “us”). By creating an account or using the Service you agree to these terms and to our <a href="/privacy">Privacy Policy</a>. Questions: <a href="mailto:support@toru.tools">support@toru.tools</a>.</p>

    <h2 id="service">The Service</h2>
    <p>Toru turns a request from your AI agent into a recorded, rendered and checked product demo. The Service is in a limited public beta: features, capacity, supported agents and limits may change, and some features are available only to invited accounts. We do not guarantee that a given flow can be completed or recorded; a useful partial recording may be delivered when the full flow could not be finished.</p>

    <h2 id="accounts">Accounts</h2>
    <p>You must be at least 18 years old, or the age of majority where you live, and able to enter into this agreement. If you use Toru for an organization, you confirm you are authorized to bind it. Keep your sign-in and connector credentials secure; you are responsible for activity under your account, including actions your connected agents request. Tell us promptly at support@toru.tools if you suspect unauthorized use.</p>

    <h2 id="acceptable-use">Acceptable use</h2>
    <p>Use Toru only with websites, apps, accounts and content you own or are authorized to access and record. You must not use the Service to:</p>
    <ul>
      <li>record, access or operate systems, accounts or data without permission, or bypass authentication, paywalls, rate limits or other access controls;</li>
      <li>collect personal data about others in breach of law, or record content you have no right to use;</li>
      <li>create misleading, defamatory, infringing, harassing or illegal material, or impersonate others;</li>
      <li>interfere with, overload, probe, reverse engineer or copy the Service, or use it to build a competing product;</li>
      <li>resell or share access to the Service without our written permission.</li>
    </ul>
    <p>Review every video before you share it, especially when the recorded screens may show personal or confidential information.</p>

    <h2 id="content">Your content</h2>
    <p>You keep all rights in the products you record, the instructions and plans you or your agent send, the brand assets you upload and the videos we deliver to you (“Your Content”). You grant us a limited license to host, process, render and deliver Your Content only to provide, secure and support the Service for you. We do not sell Your Content or use it to advertise.</p>

    <h2 id="ours">Our property</h2>
    <p>The Service, including its software, design, documentation and the Toru name and marks, belongs to us and our licensors. These terms give you a personal, non-exclusive, non-transferable right to use the Service while your account is in good standing. Feedback you send may be used to improve Toru without obligation to you.</p>

    <h2 id="billing">Plans, credits and billing</h2>
    <p>Free includes 10 credits per UTC calendar month, with up to 2 minutes of capture per video. Creator costs US$19 per monthly billing cycle for 50 credits and Studio US$49 for 150 credits, each with up to 5 minutes of capture per video and 30 days of MP4 storage. The allowance for your account is shown in the console. Unused monthly credits do not roll over.</p>
    <p>One credit covers one delivered video. A credit is used when the first MP4 of a recording is delivered, including a useful partial attempt. Videos held back by the delivery check, downloads and retries of a technical failure do not use another credit. Payments are processed by our payment provider; paid access begins once the payment is confirmed. Prices exclude taxes where applicable. Manage or cancel renewal through the billing link in the console or by email; cancellation keeps paid access through the current period and stops the next renewal.</p>

    <h2 id="refunds">Refunds</h2>
    <p>We offer a full refund if you request it within 14 calendar days of any paid plan charge, even if you used the Service. Email the account address and charge date from your account e-mail; never send card details. We aim to acknowledge requests within two business days and to initiate approved refunds to the original payment method within five business days; your bank controls when funds appear. We also correct duplicate or erroneous charges and honor any broader rights required by law. A refund does not close your account; tell us if you also want renewal stopped.</p>

    <h2 id="third-parties">Your agent and third-party products</h2>
    <p>Toru works with AI agents and MCP clients you choose, and records products operated by you or third parties. Those are governed by their own terms, and their providers may process your prompts and data under their own policies. We are not responsible for third-party products, their availability or their content.</p>

    <h2 id="disclaimers">Disclaimers</h2>
    <p>The Service is provided “as is” and “as available”. To the extent permitted by law, we disclaim all warranties, express or implied, including merchantability, fitness for a particular purpose and non-infringement, and we do not warrant that the Service will be uninterrupted, error-free or that every recording will succeed.</p>

    <h2 id="liability">Limitation of liability</h2>
    <p>To the extent permitted by law, we are not liable for indirect, incidental, special, consequential or punitive damages, or for lost profits, revenue, data or goodwill. Our total liability for any claim relating to the Service is limited to the amount you paid us in the 12 months before the claim, or US$50 if greater. Nothing in these terms limits liability that cannot be limited by law, or your mandatory rights as a consumer.</p>

    <h2 id="indemnity">Indemnity</h2>
    <p>You will defend and indemnify us against third-party claims arising from Your Content, the products and accounts you record, or your breach of these terms or of the law.</p>

    <h2 id="termination">Suspension and termination</h2>
    <p>You may stop using Toru and delete your account at any time from the console. We may suspend or end access if you breach these terms, if required by law, or to protect the Service or others; where reasonable we will tell you first. We may pause new work for capacity or maintenance. On termination your right to use the Service ends; retention and deletion follow the <a href="/privacy#retention">Privacy Policy</a>.</p>

    <h2 id="changes">Changes</h2>
    <p>We may update these terms. If a change materially affects you, we will notify you before it applies, and changes to paid limits or retention will not apply to a paid period already in progress. Continuing to use the Service after a change takes effect means you accept it.</p>

    <h2 id="contact">Contact</h2>
    <p>Support, billing, refunds and legal notices: <a href="mailto:support@toru.tools">support@toru.tools</a>. The Service is offered where lawful and supported by our payment provider.</p>
  </PublicPage>;
}
