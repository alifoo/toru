import {expect,it} from 'vitest';
import {appUpdateRequired,compareVersions} from './app-version.js';
it('compares dotted versions numerically and treats unknown clients as oldest',()=>{
 expect(compareVersions('0.10.0','0.9.9')).toBe(1);expect(compareVersions('1.0','1.0.0')).toBe(0);expect(compareVersions('dev','0.0.1')).toBe(-1);
 expect(appUpdateRequired(undefined,undefined)).toBe(false);expect(appUpdateRequired('0.1.0','0.0.0')).toBe(false);
 expect(appUpdateRequired('0.1.0','0.2.0')).toBe(true);expect(appUpdateRequired('0.2.0','0.2.0')).toBe(false);expect(appUpdateRequired(undefined,'0.2.0')).toBe(true);
 expect(appUpdateRequired('../x','0.2.0')).toBe(true);
});
