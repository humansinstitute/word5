import { Database } from 'bun:sqlite';
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { applyMigration, manifest, rollbackMigration, sha256, type MigrationInput } from '../src/reconciliation-migration';
const [op,path,inputPath,outputPath,reviewPath,batchId]=process.argv.slice(2);
function exclusive(path:string,bytes:string|Uint8Array){if(!path)throw new Error('Output path required');writeFileSync(path,bytes,{flag:'wx',mode:0o600});}
if(!path||!['snapshot','preview','apply','rollback'].includes(op))throw new Error('Usage: snapshot DB OUTPUT | preview SNAPSHOT INPUT OUTPUT | apply DB INPUT BACKUP REVIEWED_MANIFEST BATCH | rollback DB BATCH');
if(op==='snapshot'){
 if(existsSync(inputPath))throw new Error('Snapshot exists');const db=new Database(path,{readonly:true});db.query('VACUUM INTO ?').run(inputPath);db.close();chmodSync(inputPath,0o600);const bytes=readFileSync(inputPath);exclusive(inputPath+'.sha256',sha256(bytes)+'\n');
 console.log(JSON.stringify({snapshot:inputPath,sha256:sha256(bytes)}));
}else if(op==='preview'){
 const input=JSON.parse(readFileSync(inputPath,'utf8')) as MigrationInput;
 const temp=mkdtempSync(outputPath+'.work-');const copy=temp+'/preview.sqlite';copyFileSync(path,copy);const db=new Database(copy);
 const result=db.transaction(()=>manifest(db,input))();db.close();rmSync(temp,{recursive:true});exclusive(outputPath,JSON.stringify(result,null,2));console.log(JSON.stringify({manifest:outputPath,players:result.players.length,inserted:result.insertedEventIds.length,conflicts:result.conflicts.length}));
}else if(op==='apply'){
 if(!batchId||!reviewPath||!outputPath)throw new Error('Exact reviewed manifest, batch ID and fresh backup path required');
 const input=JSON.parse(readFileSync(inputPath,'utf8')),review=JSON.parse(readFileSync(reviewPath,'utf8'));
 if(existsSync(outputPath))throw new Error('Backup exists');const db=new Database(path);db.query('VACUUM INTO ?').run(outputPath);chmodSync(outputPath,0o600);exclusive(outputPath+'.sha256',sha256(readFileSync(outputPath))+'\n');
 const result=applyMigration(db,input,review,batchId);db.close();console.log(JSON.stringify({batchId,backup:outputPath,sha256:result.inputSha256}));
}else{
 const db=new Database(path);rollbackMigration(db,inputPath);db.close();console.log(JSON.stringify({rolledBack:inputPath,rawEvidenceAndNewCompletionsPreserved:true}));
}
