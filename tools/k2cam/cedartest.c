/*
 * cedartest: decode an H.264 keyframe with the K2's hardware video engine (Allwinner
 * CedarC v1.3.0, /dev/cedar_dev) by dlopen()ing the printer's own libvdecoder.so.
 * Struct layouts from libcedarc 2021 headers (lindenis-v853), checked against the
 * printer's InitializeVideoDecoder (VConfig offsets 80/148/156/160). Every struct we
 * hand in is padded with zeros in case v1.3.0 appended fields.
 * Usage: cedartest <keyframe.h264> [runs=10] [out.yuv]
 */
#include <dlfcn.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <sys/resource.h>
#include <stddef.h>

typedef struct { int eCodecFormat, nWidth, nHeight, nFrameRate, nFrameDuration, nAspectRatio, bIs3DStream, nCodecSpecificDataLen; char *pCodecSpecificData;
  int bSecureStreamFlag, bSecureStreamFlagLevel1, bIsFramePackage, h265ReferencePictureNum, bReOpenEngine, bIsFrameCtsTestFlag; } VideoStreamInfo;
typedef struct { int bScaleDownEn, bRotationEn, bSecOutputEn, nHorizonScaleDownRatio, nVerticalScaleDownRatio, nSDWidth, nSDHeight, bAnySizeSD,
  nSecHorizonScaleDownRatio, nSecVerticalScaleDownRatio, nRotateDegree, bThumbnailMode, eOutputPixelFormat, eSecOutputPixelFormat, bNoBFrames,
  bDisable3D, bSupportMaf, bDispErrorFrame, nVbvBufferSize, nFrameBufferNum, bSecureosEn, bGpuBufValid, nAlignStride, bIsSoftDecoderFlag,
  bVirMallocSbm, bSupportPallocBufBeforeDecode, nDeInterlaceHoldingFrameBufferNum, nDisplayHoldingFrameBufferNum, nRotateHoldingFrameBufferNum,
  nDecodeSmoothFrameBufferNum, bIsTvStream; void *memops; int eCtlAfbcMode, eCtlIptvMode; void *veOpsS, *pVeOpsSelf; int bConvertVp910bitTo8bit;
  unsigned nVeFreq; int bCalledByOmxFlag, bSetProcInfoEnable, nSetProcInfoFreq, nChannelNum, nSupportMaxWidth, nSupportMaxHeight, commonConfigFlag, bATMFlag; } VConfig;
typedef struct { char *pData; int nLength; int64_t nPts, nPcr; int bIsFirstPart, bIsLastPart, nID, nStreamIndex, bValid; unsigned bVideoInfoFlag; void *pVideoInfo; } VideoStreamDataInfo;
typedef struct { int nID, nStreamIndex, ePixelFormat, nWidth, nHeight, nLineStride, nTopOffset, nLeftOffset, nBottomOffset, nRightOffset,
  nFrameRate, nAspectRatio, bIsProgressive, bTopFieldFirst, bRepeatTopField; int64_t nPts, nPcr; char *pData0, *pData1, *pData2, *pData3; } VideoPicture;
struct ScMemOpsS { int (*open)(void); int (*open2)(void *, void *); void (*close)(void); int (*total_size)(void); void *(*palloc)(int, void *, void *);
  void *(*palloc_no_cache)(int, void *, void *); void (*pfree)(void *, void *, void *); void (*flush_cache)(void *, int); };

#define PAD 1024
static double ms(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec * 1e3 + t.tv_nsec / 1e6; }
#define SYM(lib, name) void *name##_p = dlsym(lib, #name); if (!name##_p) { printf("missing %s\n", #name); return 1; }

int main(int argc, char **argv) {
  if (argc < 2) { puts("usage: cedartest <keyframe.h264> [runs] [out.yuv]"); return 1; }
  int runs = argc > 2 ? atoi(argv[2]) : 10; const char *out = argc > 3 && argv[3][0] ? argv[3] : NULL; int framePkg = argc > 4 ? atoi(argv[4]) : 1; int useAud = argc > 5 ? atoi(argv[5]) : 0; int noB = argc > 6 ? atoi(argv[6]) : 0;
  static char kfs[8][1 << 19]; int kflens[8], nkf = 0;
  for (char *tok = strtok(argv[1], ","); tok && nkf < 8; tok = strtok(NULL, ",")) {
    FILE *f = fopen(tok, "rb"); if (!f) { perror(tok); return 1; }
    kflens[nkf] = fread(kfs[nkf], 1, sizeof kfs[0] - 8, f); fclose(f);
    static const char aud[6] = { 0, 0, 0, 1, 0x09, 0x10 }; if (useAud) { memcpy(kfs[nkf] + kflens[nkf], aud, 6); kflens[nkf] += 6; } nkf++;
  }
  char *kf = kfs[0]; int kflen = kflens[0]; int wrote = 0;
  void *mem = dlopen("libMemAdapter.so", RTLD_NOW | RTLD_GLOBAL), *vd = dlopen("libvdecoder.so", RTLD_NOW | RTLD_GLOBAL);
  if (!mem || !vd) { printf("dlopen: %s\n", dlerror()); return 1; }
  /* Register the H.264 codec plugin (what the player's AddVDPlugin() does for every libaw*.so). */
  void *h264 = dlopen("libawh264.so", RTLD_NOW | RTLD_GLOBAL);
  if (!h264) { printf("dlopen libawh264: %s\n", dlerror()); return 1; }
  void (*pluginInit)(void) = (void (*)(void))dlsym(h264, "CedarPluginVDInit");
  if (!pluginInit) { puts("no CedarPluginVDInit"); return 1; }
  pluginInit();
  SYM(mem, MemAdapterGetOpsS) SYM(vd, CreateVideoDecoder) SYM(vd, InitializeVideoDecoder) SYM(vd, RequestVideoStreamBuffer)
  SYM(vd, SubmitVideoStreamData) SYM(vd, DecodeVideoStream) SYM(vd, RequestPicture) SYM(vd, ReturnPicture) SYM(vd, DestroyVideoDecoder)
  struct ScMemOpsS *memops = ((struct ScMemOpsS *(*)(void))MemAdapterGetOpsS_p)();
  if (!memops) { puts("no memops"); return 1; }
  memops->open();
  void *dec = ((void *(*)(void))CreateVideoDecoder_p)();
  printf("decoder %p, keyframe %d bytes\n", dec, kflen);
  VideoStreamInfo *si = calloc(1, sizeof *si + PAD); VConfig *vc = calloc(1, sizeof *vc + PAD);
  si->eCodecFormat = 0x115; si->nWidth = 1920; si->nHeight = 1080; si->bIsFramePackage = framePkg;
  vc->eOutputPixelFormat = 5; /* NV21 */ vc->bNoBFrames = noB; vc->nVbvBufferSize = 2 << 20; vc->memops = memops;
  printf("sizeof VConfig %zu (memops at %zu), VideoPicture fields: pData0 at %zu\n", sizeof(VConfig), offsetof(VConfig, memops), offsetof(VideoPicture, pData0));
  int r = ((int (*)(void *, VideoStreamInfo *, VConfig *))InitializeVideoDecoder_p)(dec, si, vc);
  printf("InitializeVideoDecoder -> %d\n", r); if (r) return 1;
  double total = 0; int got = 0;
  for (int i = 0; i < runs; i++) {
    kf = kfs[i % nkf]; kflen = kflens[i % nkf];
    double t0 = ms();
    char *b0 = 0, *b1 = 0; int s0 = 0, s1 = 0;
    r = ((int (*)(void *, int, char **, int *, char **, int *, int))RequestVideoStreamBuffer_p)(dec, kflen, &b0, &s0, &b1, &s1, 0);
    if (r || !b0 || s0 + s1 < kflen) { printf("RequestVideoStreamBuffer -> %d (%d+%d)\n", r, s0, s1); break; }
    if (s0 >= kflen) memcpy(b0, kf, kflen); else { memcpy(b0, kf, s0); memcpy(b1, kf + s0, kflen - s0); }
    VideoStreamDataInfo *di = calloc(1, sizeof *di + PAD);
    di->pData = b0; di->nLength = kflen; di->nPts = i * 1000000LL; di->bIsFirstPart = 1; di->bIsLastPart = 1; di->bValid = 1;
    r = ((int (*)(void *, VideoStreamDataInfo *, int))SubmitVideoStreamData_p)(dec, di, 0); free(di);
    if (r) { printf("SubmitVideoStreamData -> %d\n", r); break; }
    int dr = -9, loops = 0;
    VideoPicture *pic = NULL;
    char trace[128] = ""; int tl = 0;
    while (loops++ < 50) {
      dr = ((int (*)(void *, int, int, int, int64_t))DecodeVideoStream_p)(dec, 0, 0, 0, 0);
      pic = ((VideoPicture *(*)(void *, int))RequestPicture_p)(dec, 0);
      if (tl < (int)sizeof trace - 8) tl += snprintf(trace + tl, sizeof trace - tl, "%d%s ", dr, pic ? "P" : "");
      if (pic || dr < 0) break;
      usleep(2000);   /* the engine finishes asynchronously (interrupt); give it a moment */
    }
    if (i < 3) printf("run %d decode results: %s\n", i, trace);
    double t1 = ms();
    if (!pic) { printf("run %d: decode -> %d, no picture (loops %d)\n", i, dr, loops); continue; }
    if (got) total += t1 - t0;
    got++;
    printf("run %d: decode -> %d, picture %dx%d stride %d fmt %d data0 %p data1 %p, %.1f ms\n", i, dr, pic->nWidth, pic->nHeight, pic->nLineStride, pic->ePixelFormat, pic->pData0, pic->pData1, t1 - t0);
    if (!wrote && out && pic->pData0) { wrote = 1;
      int ysz = pic->nLineStride * pic->nHeight;
      memops->flush_cache(pic->pData0, ysz); if (pic->pData1) memops->flush_cache(pic->pData1, ysz / 2);
      FILE *o = fopen(out, "wb"); if (!o) { perror(out); } else { fwrite(pic->pData0, 1, ysz, o); if (pic->pData1) fwrite(pic->pData1, 1, ysz / 2, o); fclose(o); }
      printf("wrote %s (%d + %d bytes)\n", out, ysz, ysz / 2);
    }
    ((int (*)(void *, VideoPicture *))ReturnPicture_p)(dec, pic);
  }
  if (got > 1) printf("pictures %d of %d runs, average after the first: %.1f ms\n", got, runs, total / (got - 1));
  struct rusage ru; getrusage(RUSAGE_SELF, &ru);
  printf("process CPU total: user %.0f ms, sys %.0f ms (%.1f ms per picture)\n", ru.ru_utime.tv_sec * 1e3 + ru.ru_utime.tv_usec / 1e3,
         ru.ru_stime.tv_sec * 1e3 + ru.ru_stime.tv_usec / 1e3,
         got ? (ru.ru_utime.tv_sec * 1e3 + ru.ru_utime.tv_usec / 1e3 + ru.ru_stime.tv_sec * 1e3 + ru.ru_stime.tv_usec / 1e3) / got : 0);
  ((void (*)(void *))DestroyVideoDecoder_p)(dec);
  memops->close();
  return 0;
}
