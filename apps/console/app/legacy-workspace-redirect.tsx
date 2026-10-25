'use client';
import {useEffect} from 'react';
import {APP_URL} from './site';
export function LegacyWorkspaceRedirect(){
 useEffect(()=>{
  if(window.location.hostname==='toru.tools'&&['#recordings','#new','#connect','#activity','#settings'].includes(window.location.hash))window.location.replace(APP_URL+'/'+window.location.search+window.location.hash);
 },[]);
 return null;
}
