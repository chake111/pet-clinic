package com.petclinic.service;

import com.petclinic.common.BizException;
import com.petclinic.config.AppProperties;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;

/**
 * 本地磁盘文件存储（头像、宠物照片、症状图、检查图）。
 *
 * 安全要点：落盘文件名一律用服务端生成的 UUID + 白名单校验过的扩展名，
 * 绝不使用客户端传来的原始文件名拼接路径——否则 ../../ 之类的路径穿越
 * 能把文件写到 uploads 目录之外。
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class FileStorageService {

    private static final Set<String> ALLOWED_EXT = Set.of("jpg", "jpeg", "png", "gif", "webp");
    private static final DateTimeFormatter DIR_FMT = DateTimeFormatter.ofPattern("yyyy/MM/dd");

    private final AppProperties props;

    /** @return 可直接给前端用的访问 URL，如 /api/uploads/2026/09/13/ab12cd.png */
    public String store(MultipartFile file) {
        if (file == null || file.isEmpty()) {
            throw new BizException("请选择要上传的文件");
        }
        if (file.getSize() > props.getUpload().getMaxSizeBytes()) {
            throw new BizException("文件不能超过 " + props.getUpload().getMaxSizeBytes() / 1024 / 1024 + "MB");
        }
        String ext = extractSafeExt(file.getOriginalFilename());
        requireImageHeader(file, ext);

        String subDir = LocalDate.now().format(DIR_FMT);
        Path base = Paths.get(props.getUpload().getDir()).toAbsolutePath().normalize();
        Path targetDir = base.resolve(subDir).normalize();
        // 纵深防御：即便 ext 已校验，也确认最终路径仍在 base 之内
        if (!targetDir.startsWith(base)) {
            log.warn("上传路径越界，已拒绝: {}", targetDir);
            throw new BizException("文件上传失败，请稍后重试");
        }
        String filename = UUID.randomUUID().toString().replace("-", "") + "." + ext;

        try {
            Files.createDirectories(targetDir);
            file.transferTo(targetDir.resolve(filename));
        } catch (IOException e) {
            log.error("文件写入失败", e);
            throw new BizException(500, "文件上传失败，请重试");
        }
        return props.getUpload().getUrlPrefix() + "/" + subDir + "/" + filename;
    }

    private void requireImageHeader(MultipartFile file, String ext) {
        try (InputStream input = file.getInputStream()) {
            byte[] header = input.readNBytes(12);
            String text = new String(header, StandardCharsets.ISO_8859_1);
            boolean matches = switch (ext) {
                case "jpg", "jpeg" -> header.length >= 3 && (header[0] & 255) == 0xff
                        && (header[1] & 255) == 0xd8 && (header[2] & 255) == 0xff;
                case "png" -> text.startsWith("\u0089PNG\r\n\u001a\n");
                case "gif" -> text.startsWith("GIF87a") || text.startsWith("GIF89a");
                case "webp" -> header.length == 12 && text.startsWith("RIFF") && text.substring(8).equals("WEBP");
                default -> false;
            };
            if (!matches) {
                throw new BizException("图片内容与文件格式不符，请重新选择图片");
            }
        } catch (IOException e) {
            throw new BizException("无法读取图片，请重新选择");
        }
    }

    /**
     * 提取末段文件名的扩展名并转为小写。
     *
     * @param originalName 原始文件名，先移除最后一个正斜杠或反斜杠之前的内容
     * @return 白名单内的扩展名：jpg、jpeg、png、gif 或 webp
     * @throws BizException 文件名为 null、缺少扩展名或扩展名不在白名单内
     */
    private String extractSafeExt(String originalName) {
        if (originalName == null) {
            throw new BizException("无法识别文件类型");
        }
        int slash = Math.max(originalName.lastIndexOf('/'), originalName.lastIndexOf('\\'));
        String name = slash >= 0 ? originalName.substring(slash + 1) : originalName;
        int dot = name.lastIndexOf('.');
        if (dot < 0 || dot == name.length() - 1) {
            throw new BizException("文件缺少扩展名");
        }
        String ext = name.substring(dot + 1).toLowerCase(Locale.ROOT);
        if (!ALLOWED_EXT.contains(ext)) {
            throw new BizException("仅支持 " + String.join("/", ALLOWED_EXT) + " 格式图片");
        }
        return ext;
    }
}
