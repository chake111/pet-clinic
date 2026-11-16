package com.petclinic.controller.admin;

import com.petclinic.common.PageResult;
import com.petclinic.common.Result;
import com.petclinic.dto.PageQuery;
import com.petclinic.dto.ReplyForm;
import com.petclinic.security.LoginUser;
import com.petclinic.security.RequireRole;
import com.petclinic.service.DoctorReviewService;
import com.petclinic.vo.ReviewVo;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

/**
 * 医生评价管理：医生回复自己收到的评价，管理员负责屏蔽违规评价。
 *
 * 隐藏一条评价会重算该医生的评分聚合（统计 SQL 只认 status=1），
 * 这一步写在 Service 里，不放前端。
 */
@Tag(name = "管理后台-医生评价")
@RestController
@RequestMapping("/admin/review")
@RequiredArgsConstructor
public class AdminReviewController {

    private final DoctorReviewService reviewService;

    @Operation(summary = "评价分页（医生账号自动限定为本人）")
    @GetMapping("/page")
    public Result<PageResult<ReviewVo>> page(@RequestParam(required = false) Long doctorId,
                                             @RequestParam(required = false) Integer status,
                                             PageQuery query) {
        return Result.ok(reviewService.pageForStaff(doctorId, status, query));
    }

    @Operation(summary = "回复评价")
    @PostMapping("/{id}/reply")
    public Result<Void> reply(@PathVariable Long id, @Valid @RequestBody ReplyForm req) {
        reviewService.reply(id, req.getReply());
        return Result.ok("已回复", null);
    }

    @Operation(summary = "显示 / 隐藏评价（仅管理员，会重算医生评分）")
    @PutMapping("/{id}/status")
    @RequireRole(LoginUser.ROLE_ADMIN)
    public Result<Void> changeStatus(@PathVariable Long id, @RequestParam Integer status) {
        reviewService.changeStatus(id, status);
        return Result.ok(status == 1 ? "已显示" : "已隐藏", null);
    }
}
