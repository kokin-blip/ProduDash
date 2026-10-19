import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveMediaFile } from '../src/media.js';
import { validate } from '../src/validation.js';

const browserPost = {video_path:'clip.mp4', title:'Browser posting test', privacy_level:'SELF_ONLY',
  consent:true, disable_comment:true, disable_duet:true, disable_stitch:true,
  brand_content_toggle:false, brand_organic_toggle:false, is_aigc:false};

test('browser posting is the default and needs no token or public media URL', () => {
  const result = validate('/v1/posts', browserPost);
  assert.equal(result.provider, 'browser'); assert.equal(result.dry_run, true);
  assert.throws(() => validate('/v1/posts', {...browserPost, video_url:'https://example.com/clip.mp4'}));
  assert.throws(() => validate('/v1/posts', {...browserPost, disable_duet:false}));
  assert.throws(() => validate('/v1/posts', {...browserPost, consent:false}));
});
test('media lookup accepts only files under the configured root, including real symlink targets', async t => {
  const dir = await mkdtemp(join(tmpdir(),'tiktok-media-'));
  t.after(() => rm(dir,{recursive:true,force:true}));
  const root = join(dir,'media'); await mkdir(root);
  await writeFile(join(root,'clip.mp4'),'test');
  await writeFile(join(dir,'outside.mp4'),'test');
  await symlink(join(dir,'outside.mp4'),join(root,'escape.mp4'));
  assert.equal(await resolveMediaFile(root,'clip.mp4'),await resolveMediaFile(root,join(root,'clip.mp4')));
  await assert.rejects(resolveMediaFile(root,'../outside.mp4'),{code:'media_path_not_allowed'});
  await assert.rejects(resolveMediaFile(root,'escape.mp4'),{code:'media_path_not_allowed'});
  await assert.rejects(resolveMediaFile(root,'missing.mp4'),{code:'media_not_found'});
  await writeFile(join(root,'empty.mp4'),'');
  await writeFile(join(root,'notes.txt'),'test');
  await assert.rejects(resolveMediaFile(root,'empty.mp4'),{code:'media_invalid'});
  await assert.rejects(resolveMediaFile(root,'notes.txt'),{code:'media_invalid'});
});
