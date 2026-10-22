{
  "targets": [
    {
      "target_name": "mac-coregraphics",
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "sources": ["src/main.mm"],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "dependencies": ["<!(node -p \"require('node-addon-api').gyp\")"],
      "xcode_settings": {
        "MACOSX_DEPLOYMENT_TARGET": "10.15",
        "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
        "GCC_ENABLE_OBJC_EXCEPTIONS": "YES",
        "CLANG_CXX_LIBRARY": "libc++",
        "OTHER_LDFLAGS": [
          "-framework CoreGraphics",
          "-framework Carbon",
          "-framework Foundation"
        ]
      },
      "cflags_cc!": ["-fno-exceptions"],
      "cflags_c!": ["-fno-exceptions"]
    }
  ]
}
