package com.petclinic.controller.common;

import com.petclinic.common.Result;
import com.petclinic.service.FileStorageService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

import java.util.Map;

/**
 * 双端共用接口。目前只有图片上传，需登录但不区分用户端/后台。
 */
@Tag(name = "公共-上传")
@RestController
@RequestMapping("/common/upload")
@RequiredArgsConstructor
public class UploadController {

    private final FileStorageService fileStorageService;

    @Operation(summary = "上传单张图片，返回可访问 URL")
    @PostMapping
    public Result<Map<String, String>> upload(@RequestParam("file") MultipartFile file) {
        String url = fileStorageService.store(file);
        return Result.ok(Map.of("url", url));
    }
}
