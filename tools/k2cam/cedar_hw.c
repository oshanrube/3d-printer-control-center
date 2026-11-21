/*
 * cedar_hw.c: H.264 keyframe -> JPEG entirely on the K2's Allwinner video engine.
 *
 * Uses the printer's own CedarC v1.3.0 libraries via dlopen (see README.md):
 *   decode: libvdecoder + libawh264 (H.264 -> NV21 1920x1088)
 *   encode: libvencoder (JPEG, with the encoder's scaler: e.g. 1920x1080 -> 1280x720)
 * Struct layouts from libcedarc 2021 (Lindenis V853 Tina SDK); every struct handed to the
 * libraries is zero-padded in case v1.3.0 appended fields.
 *
 * API:
 *   int  hw_open(int dstW, int dstH, int quality);       0 = ok
 *   int  hw_jpeg(const char *h264, int len, unsigned char **jpg, int *jlen);
 *        1 = JPEG produced (malloc'd, caller frees), 0 = none yet (decoder needs the next
 *        frame first), <0 = error
 *   void hw_close(void);
 * Build the test: arm-linux-gnueabihf-gcc -O2 -DCEDAR_HW_TEST -o hwjpegtest cedar_hw.c -ldl
 */
#include <dlfcn.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

/* ---- decoder structs (vdecoder.h / vbasetype.h) ---- */
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
  nFrameRate, nAspectRatio, bIsProgressive, bTopFieldFirst, bRepeatTopField; int64_t nPts, nPcr; char *pData0, *pData1, *pData2, *pData3;
  int bMafValid; char *pMafData; int nMafFlagStride, bPreFrmValid, nBufId; unsigned long phyYBufAddr, phyCBufAddr; } VideoPicture;
struct ScMemOpsS { int (*open)(void); int (*open2)(void *, void *); void (*close)(void); int (*total_size)(void); void *(*palloc)(int, void *, void *);
  void *(*palloc_no_cache)(int, void *, void *); void (*pfree)(void *, void *, void *); void (*flush_cache)(void *, int);
  void *(*ve_get_phyaddr)(void *); void *(*ve_get_viraddr)(void *); void *(*cpu_get_phyaddr)(void *); void *(*cpu_get_viraddr)(void *); };

/* ---- encoder structs (vencoder.h) ---- */
enum { VENC_CODEC_JPEG = 1, VENC_PIXEL_YVU420SP = 1, VENC_IndexParamJpegQuality = 0x200, VENC_IndexParamJpegEncMode = 0x202 };
typedef struct { unsigned char bEncH264Nalu; unsigned nInputWidth, nInputHeight, nDstWidth, nDstHeight, nStride; int eInputFormat;
  struct ScMemOpsS *memops; void *veOpsS, *pVeOpsSelf; unsigned char bOnlyWbFlag, bLbcLossyComEnFlag2x, bLbcLossyComEnFlag2_5x, bIsVbvNoCache; } VencBaseConfig;
typedef struct { int nLeft, nTop, nWidth, nHeight; } VencRect;
typedef struct { unsigned long nID; long long nPts; unsigned nFlag; unsigned char *pAddrPhyY, *pAddrPhyC, *pAddrVirY, *pAddrVirC;
  int nWidth, nHeight, nAlign, bEnableCorp; VencRect sCropInfo; } VencInputBuffer;
typedef struct { int nID; long long nPts; unsigned nFlag, nSize0, nSize1; unsigned char *pData0, *pData1; } VencOutputBuffer;
typedef struct { unsigned nBufferNum, nSizeY, nSizeC; } VencAllocateBufferParam;

#define PAD 1024
static struct ScMemOpsS *memops;
static void *dec, *enc;
static int dstW, dstH, quality, encW, encH, encReady;
int hw_zero_copy = 1;      /* hand the decoder's frame to the encoder by physical address (no CPU copy) */
static int zc_checked;
static void *(*fCreateVideoDecoder)(void); static int (*fInitializeVideoDecoder)(void *, VideoStreamInfo *, VConfig *);
static int (*fRequestVideoStreamBuffer)(void *, int, char **, int *, char **, int *, int);
static int (*fSubmitVideoStreamData)(void *, VideoStreamDataInfo *, int);
static int (*fDecodeVideoStream)(void *, int, int, int, int64_t);
static VideoPicture *(*fRequestPicture)(void *, int); static int (*fReturnPicture)(void *, VideoPicture *);
static void (*fDestroyVideoDecoder)(void *);
static void *(*fVideoEncCreate)(int); static void (*fVideoEncDestroy)(void *); static int (*fVideoEncInit)(void *, VencBaseConfig *);
static int (*fVideoEncUnInit)(void *); static int (*fVideoEncSetParameter)(void *, int, void *);
static int (*fAllocInputBuffer)(void *, VencAllocateBufferParam *); static int (*fGetOneAllocInputBuffer)(void *, VencInputBuffer *);
static int (*fFlushCacheAllocInputBuffer)(void *, VencInputBuffer *); static int (*fReturnOneAllocInputBuffer)(void *, VencInputBuffer *);
static int (*fAddOneInputBuffer)(void *, VencInputBuffer *); static int (*fVideoEncodeOneFrame)(void *);
static int (*fAlreadyUsedInputBuffer)(void *, VencInputBuffer *); static int (*fGetOneBitstreamFrame)(void *, VencOutputBuffer *);
static int (*fFreeOneBitStreamFrame)(void *, VencOutputBuffer *); static int (*fReleaseAllocInputBuffer)(void *);

#define LOAD(lib, fn) do { *(void **)&f##fn = dlsym(lib, #fn); if (!f##fn) { fprintf(stderr, "cedar_hw: missing %s\n", #fn); return -1; } } while (0)

int hw_open(int w, int h, int q) {
  dstW = w; dstH = h; quality = q;
  void *mem = dlopen("libMemAdapter.so", RTLD_NOW | RTLD_GLOBAL), *vd = dlopen("libvdecoder.so", RTLD_NOW | RTLD_GLOBAL);
  void *h264 = dlopen("libawh264.so", RTLD_NOW | RTLD_GLOBAL), *ve = dlopen("libvencoder.so", RTLD_NOW | RTLD_GLOBAL);
  if (!mem || !vd || !h264 || !ve) { fprintf(stderr, "cedar_hw: dlopen: %s\n", dlerror()); return -1; }
  struct ScMemOpsS *(*getOps)(void) = (struct ScMemOpsS *(*)(void))dlsym(mem, "MemAdapterGetOpsS");
  void (*pluginInit)(void) = (void (*)(void))dlsym(h264, "CedarPluginVDInit");
  if (!getOps || !pluginInit) { fprintf(stderr, "cedar_hw: missing MemAdapterGetOpsS/CedarPluginVDInit\n"); return -1; }
  LOAD(vd, CreateVideoDecoder); LOAD(vd, InitializeVideoDecoder); LOAD(vd, RequestVideoStreamBuffer); LOAD(vd, SubmitVideoStreamData);
  LOAD(vd, DecodeVideoStream); LOAD(vd, RequestPicture); LOAD(vd, ReturnPicture); LOAD(vd, DestroyVideoDecoder);
  LOAD(ve, VideoEncCreate); LOAD(ve, VideoEncDestroy); LOAD(ve, VideoEncInit); LOAD(ve, VideoEncUnInit); LOAD(ve, VideoEncSetParameter);
  LOAD(ve, AllocInputBuffer); LOAD(ve, GetOneAllocInputBuffer); LOAD(ve, FlushCacheAllocInputBuffer); LOAD(ve, ReturnOneAllocInputBuffer);
  LOAD(ve, AddOneInputBuffer); LOAD(ve, VideoEncodeOneFrame); LOAD(ve, AlreadyUsedInputBuffer); LOAD(ve, GetOneBitstreamFrame);
  LOAD(ve, FreeOneBitStreamFrame); LOAD(ve, ReleaseAllocInputBuffer);
  memops = getOps(); if (!memops) return -1;
  memops->open();
  pluginInit();
  dec = fCreateVideoDecoder(); if (!dec) return -1;
  VideoStreamInfo *si = calloc(1, sizeof *si + PAD); VConfig *vc = calloc(1, sizeof *vc + PAD);
  si->eCodecFormat = 0x115; si->nWidth = 1920; si->nHeight = 1080; si->bIsFramePackage = 1;
  vc->eOutputPixelFormat = 5; /* NV21 */ vc->nVbvBufferSize = 2 << 20; vc->memops = memops;
  int r = fInitializeVideoDecoder(dec, si, vc); free(si); free(vc);
  if (r) { fprintf(stderr, "cedar_hw: InitializeVideoDecoder %d\n", r); return -1; }
  return 0;
}

/* The encoder is set up on the first picture, once the real size and stride are known. */
static int enc_setup(int w, int h, int stride) {
  enc = fVideoEncCreate(VENC_CODEC_JPEG); if (!enc) { fprintf(stderr, "cedar_hw: VideoEncCreate failed\n"); return -1; }
  int q = quality, mode = 0;
  fVideoEncSetParameter(enc, VENC_IndexParamJpegQuality, &q);
  fVideoEncSetParameter(enc, VENC_IndexParamJpegEncMode, &mode);
  VencBaseConfig *bc = calloc(1, sizeof *bc + PAD);
  bc->nInputWidth = w; bc->nInputHeight = h; bc->nStride = stride; bc->nDstWidth = dstW; bc->nDstHeight = dstH;
  bc->eInputFormat = VENC_PIXEL_YVU420SP; bc->memops = memops;
  int r = fVideoEncInit(enc, bc); free(bc);
  if (r) { fprintf(stderr, "cedar_hw: VideoEncInit %d\n", r); return -1; }
  VencAllocateBufferParam bp = { 1, (unsigned)(stride * ((h + 15) & ~15)), (unsigned)(stride * ((h + 15) & ~15) / 2) };
  r = fAllocInputBuffer(enc, &bp);   /* kept for the copy path (fallback) */
  if (r) { fprintf(stderr, "cedar_hw: AllocInputBuffer %d\n", r); return -1; }
  encW = w; encH = h; encReady = 1;
  return 0;
}

static int encode(VideoPicture *pic, unsigned char **jpg, int *jlen) {
  int w = pic->nWidth, h = pic->nHeight > 1080 && pic->nHeight <= 1088 ? 1080 : pic->nHeight, stride = pic->nLineStride;
  if (!encReady && enc_setup(w, h, stride)) return -1;
  if (hw_zero_copy) {
    /* Physical addresses from two independent sources must agree, or we don't trust them. */
    unsigned long py = (unsigned long)memops->ve_get_phyaddr(pic->pData0), pc = (unsigned long)memops->ve_get_phyaddr(pic->pData1);
    if (!zc_checked) {
      zc_checked = 1;
      fprintf(stderr, "cedar_hw: zero-copy check: ve_get_phyaddr Y=%#lx C=%#lx, picture phyY=%#lx phyC=%#lx\n", py, pc, pic->phyYBufAddr, pic->phyCBufAddr);
      if (!py || !pc || py != pic->phyYBufAddr || pc != pic->phyCBufAddr) { fprintf(stderr, "cedar_hw: addresses disagree, using the copy path\n"); hw_zero_copy = 0; }
    } else if (!py || py != pic->phyYBufAddr || pc != pic->phyCBufAddr) { hw_zero_copy = 0; fprintf(stderr, "cedar_hw: address mismatch, using the copy path\n"); }
  }
  if (hw_zero_copy) {
    char *zm = calloc(1, sizeof(VencInputBuffer) + PAD); VencInputBuffer *zin = (VencInputBuffer *)zm;
    zin->pAddrVirY = (unsigned char *)pic->pData0; zin->pAddrVirC = (unsigned char *)pic->pData1;
    zin->pAddrPhyY = (unsigned char *)pic->phyYBufAddr; zin->pAddrPhyC = (unsigned char *)pic->phyCBufAddr;
    zin->nWidth = w; zin->nHeight = h; zin->bEnableCorp = 0;
    int zr = fAddOneInputBuffer(enc, zin);
    if (!zr) zr = fVideoEncodeOneFrame(enc);
    fAlreadyUsedInputBuffer(enc, zin);
    free(zm);
    if (zr) { fprintf(stderr, "cedar_hw: zero-copy encode %d, using the copy path\n", zr); hw_zero_copy = 0; }
    else goto bitstream;
  }
  char *inbuf_mem = calloc(1, sizeof(VencInputBuffer) + PAD); VencInputBuffer *in = (VencInputBuffer *)inbuf_mem;
  if (fGetOneAllocInputBuffer(enc, in) || !in->pAddrVirY || !in->pAddrVirC) { fprintf(stderr, "cedar_hw: no input buffer (%p %p)\n", in->pAddrVirY, in->pAddrVirC); free(inbuf_mem); return -1; }
  int ysz = stride * pic->nHeight;
  memops->flush_cache(pic->pData0, ysz); memops->flush_cache(pic->pData1, ysz / 2);
  memcpy(in->pAddrVirY, pic->pData0, stride * h);
  memcpy(in->pAddrVirC, pic->pData1, stride * h / 2);
  in->bEnableCorp = 0; in->nPts = 0;
  fFlushCacheAllocInputBuffer(enc, in);
  int r = fAddOneInputBuffer(enc, in);
  if (!r) r = fVideoEncodeOneFrame(enc);
  fAlreadyUsedInputBuffer(enc, in);
  fReturnOneAllocInputBuffer(enc, in);
  free(inbuf_mem);
  if (r) { fprintf(stderr, "cedar_hw: encode %d\n", r); return -1; }
bitstream:;
  char *ob_mem = calloc(1, sizeof(VencOutputBuffer) + PAD); VencOutputBuffer *ob = (VencOutputBuffer *)ob_mem;
  if (fGetOneBitstreamFrame(enc, ob) || !ob->pData0 || !ob->nSize0) { fprintf(stderr, "cedar_hw: no bitstream\n"); free(ob_mem); return -1; }
  *jlen = ob->nSize0 + ob->nSize1; *jpg = malloc(*jlen);
  memcpy(*jpg, ob->pData0, ob->nSize0); if (ob->nSize1 && ob->pData1) memcpy(*jpg + ob->nSize0, ob->pData1, ob->nSize1);
  fFreeOneBitStreamFrame(enc, ob); free(ob_mem);
  return 1;
}

int hw_jpeg(const char *h264, int len, unsigned char **jpg, int *jlen) {
  char *b0 = 0, *b1 = 0; int s0 = 0, s1 = 0;
  if (fRequestVideoStreamBuffer(dec, len, &b0, &s0, &b1, &s1, 0) || !b0 || s0 + s1 < len) return -2;
  if (s0 >= len) memcpy(b0, h264, len); else { memcpy(b0, h264, s0); memcpy(b1, h264 + s0, len - s0); }
  VideoStreamDataInfo *di = calloc(1, sizeof *di + PAD);
  di->pData = b0; di->nLength = len; di->bIsFirstPart = 1; di->bIsLastPart = 1; di->bValid = 1;
  int r = fSubmitVideoStreamData(dec, di, 0); free(di);
  if (r) return -3;
  VideoPicture *pic = NULL;
  for (int i = 0; i < 50 && !pic; i++) {
    int dr = fDecodeVideoStream(dec, 0, 0, 0, 0);
    pic = fRequestPicture(dec, 0);
    if (pic || dr < 0) break;
    usleep(2000);   /* the engine finishes asynchronously */
  }
  if (!pic) return 0;
  int out = (pic->pData0 && pic->pData1 && pic->nWidth > 0 && pic->nHeight > 0) ? encode(pic, jpg, jlen) : -4;
  fReturnPicture(dec, pic);
  return out;
}

void hw_close(void) {
  if (enc) { if (encReady) fReleaseAllocInputBuffer(enc); fVideoEncUnInit(enc); fVideoEncDestroy(enc); enc = NULL; encReady = 0; }
  if (dec) { fDestroyVideoDecoder(dec); dec = NULL; }
  if (memops) { memops->close(); memops = NULL; }
}

#ifdef CEDAR_HW_TEST
#include <sys/resource.h>
#include <time.h>
static double ms(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec * 1e3 + t.tv_nsec / 1e6; }
int main(int argc, char **argv) {
  if (argc < 3) { puts("usage: hwjpegtest kf0.h264,kf1.h264,... runs [out.jpg] [WxH=1280x720] [quality=80]"); return 1; }
  int runs = atoi(argv[2]); const char *out = argc > 3 && argv[3][0] ? argv[3] : NULL;
  int w = 1280, h = 720, q = argc > 5 ? atoi(argv[5]) : 80; if (argc > 4) sscanf(argv[4], "%dx%d", &w, &h);
  if (argc > 6) hw_zero_copy = atoi(argv[6]);
  static char kfs[8][1 << 19]; int lens[8], n = 0;
  for (char *t = strtok(argv[1], ","); t && n < 8; t = strtok(NULL, ",")) { FILE *f = fopen(t, "rb"); if (!f) { perror(t); return 1; } lens[n] = fread(kfs[n], 1, sizeof kfs[0], f); fclose(f); n++; }
  if (hw_open(w, h, q)) { puts("hw_open failed"); return 1; }
  int got = 0, wrote = 0; double total = 0;
  for (int i = 0; i < runs; i++) {
    unsigned char *jpg = NULL; int jl = 0; double t0 = ms();
    int r = hw_jpeg(kfs[i % n], lens[i % n], &jpg, &jl);
    double dt = ms() - t0;
    if (r == 1) {
      if (got++) total += dt;
      if (i < 6) printf("run %d: JPEG %d bytes in %.1f ms (starts %02x %02x)\n", i, jl, dt, jpg[0], jpg[1]);
      if (out && !wrote) { FILE *o = fopen(out, "wb"); if (o) { fwrite(jpg, 1, jl, o); fclose(o); wrote = 1; } }
      free(jpg);
    } else if (i < 6) printf("run %d: result %d (%.1f ms)\n", i, r, dt);
  }
  struct rusage ru; getrusage(RUSAGE_SELF, &ru);
  double cpu = ru.ru_utime.tv_sec * 1e3 + ru.ru_utime.tv_usec / 1e3 + ru.ru_stime.tv_sec * 1e3 + ru.ru_stime.tv_usec / 1e3;
  printf("[zero-copy %s] JPEGs %d of %d, average after the first %.1f ms; process CPU %.0f ms total (%.1f ms per JPEG incl. start-up)\n",
         hw_zero_copy ? "on" : "off", got, runs, got > 1 ? total / (got - 1) : 0, cpu, got ? cpu / got : 0);
  hw_close();
  return 0;
}
#endif
