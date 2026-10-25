import {expect,it,vi} from 'vitest';

const send=vi.hoisted(()=>vi.fn());
vi.mock('@aws-sdk/client-s3',async importOriginal=>{
  const actual=await importOriginal<typeof import('@aws-sdk/client-s3')>();
  return {...actual,S3Client:class{send=send;}};
});

import {bucketObjects} from './deletion-bucket.js';

const config={name:'synthetic-deletion-bucket',endpoint:'https://example.com/',region:'auto',
  accessKeyId:'synthetic',secretAccessKey:'synthetic'};

it('accepts a complete one-page S3 listing and follows continuation tokens',async()=>{
  send.mockReset().mockResolvedValueOnce({Contents:[],IsTruncated:false});
  await expect(bucketObjects(config).list()).resolves.toEqual([]);

  send.mockReset()
    .mockResolvedValueOnce({Contents:[{Key:'agent-recorder/deletions/v1/manifest.json'}],
      IsTruncated:true,NextContinuationToken:'next'})
    .mockResolvedValueOnce({Contents:[{Key:'agent-recorder/deletions/v1/owner.json'}],IsTruncated:false});
  await expect(bucketObjects(config).list()).resolves.toEqual(['manifest.json','owner.json']);
  expect(send).toHaveBeenCalledTimes(2);
});

it('rejects a truncated S3 listing without a usable continuation token',async()=>{
  send.mockReset().mockResolvedValueOnce({Contents:[],IsTruncated:true});
  await expect(bucketObjects(config).list()).rejects.toThrow('deletion_journal_list_incomplete');
});
