import type {Metadata} from 'next';
import {PublicFooter,PublicHeader} from '../../public-chrome';
import {MacSetup} from './mac-setup';
export const metadata:Metadata={title:'Open Toru for Mac',robots:{index:false,follow:false}};
export default function MacSetupPage(){
 return <div className="public-site lw-site">
  <div className="lw-container"><PublicHeader/></div>
  <main className="legal-page">
   <p className="eyebrow">Toru for Mac</p><h1>Finish pairing in Toru</h1>
   <MacSetup/>
  </main><PublicFooter/>
 </div>;
}
