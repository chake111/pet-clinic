package com.yuzhua.controller.client;

import com.yuzhua.common.Result;
import com.yuzhua.dto.ReviewForm;
import com.yuzhua.entity.DoctorReview;
import com.yuzhua.service.DoctorReviewService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 用户端评价。医生列表/详情的评价展示走公开的 /client/catalog/**，
 * 这里只有写入口——提交后由服务端重算该医生的评分聚合。
 */
@Tag(name = "用户端-医生评价")
@RestController
@RequestMapping("/client/review")
@RequiredArgsConstructor
public class ReviewController {

    private final DoctorReviewService reviewService;

    @Operation(summary = "提交评价（仅已完成的预约，一单一评）")
    @PostMapping
    public Result<DoctorReview> submit(@Valid @RequestBody ReviewForm req) {
        return Result.ok("感谢您的评价", reviewService.submit(req));
    }
}
