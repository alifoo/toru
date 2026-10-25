'use client';
import {useRef,useState} from 'react';

export function RecordingFeedback({id}:{id:string}){
  const [useful,setUseful]=useState<boolean|null>(null),[reason,setReason]=useState('');
  const [pending,setPending]=useState(false),[message,setMessage]=useState('');
  const busy=useRef(false);
  async function submit(){
    if(useful===null||busy.current)return;
    busy.current=true;setPending(true);setMessage('Saving feedback…');
    try{
      const response=await fetch('/api/feedback',{method:'POST',signal:AbortSignal.timeout(15000),headers:{'content-type':'application/json'},
        body:JSON.stringify({id,useful,...(!useful&&reason?{reason}:{})})});
      const body=await response.json();
      if(!response.ok||body.state!=='saved')throw new Error();
      setMessage('Feedback saved. You can change your answer.');
    }catch{setMessage('Saving could not be confirmed. You can retry; the same answer is counted once.');}
    finally{busy.current=false;setPending(false);}
  }
  return <details><summary>Optional feedback</summary><fieldset disabled={pending}>
    <legend>Would you use this video?</legend>
    <label><input type="radio" name={`useful-${id}`} checked={useful===true} onChange={()=>{setUseful(true);setReason('');setMessage('Changes not saved.');}} /> Yes</label>{' '}
    <label><input type="radio" name={`useful-${id}`} checked={useful===false} onChange={()=>{setUseful(false);setMessage('Changes not saved.');}} /> No</label>
    {useful===false&&<label> Reason (optional)<select value={reason} onChange={event=>{setReason(event.target.value);setMessage('Changes not saved.');}}>
      <option value="">Prefer not to say</option><option value="quality">Video quality</option><option value="wrong_flow">Wrong flow</option>
      <option value="slow">Too slow</option><option value="other">Other</option></select></label>}
    <p>Your answer does not affect downloads or credits.</p>
    <button className="quiet" disabled={useful===null||pending} onClick={()=>void submit()}>Save feedback</button>
  </fieldset><p role="status">{message}</p></details>;
}
