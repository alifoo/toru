import {redirect} from 'next/navigation';

/** The former combined page. Its anchors (#mac, #chrome, #retention) now live in the Privacy Policy. */
export default function LegalPage(){
  redirect('/privacy');
}
