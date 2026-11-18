package com.yuzhua.controller.admin;

import com.yuzhua.common.PageResult;
import com.yuzhua.common.Result;
import com.yuzhua.dto.ConsultCloseForm;
import com.yuzhua.dto.ConsultQuery;
import com.yuzhua.dto.ConsultMessageQuery;
import com.yuzhua.entity.ConsultMessage;
import com.yuzhua.security.LoginUser;
import com.yuzhua.security.RequireRole;
import com.yuzhua.service.ConsultService;
import com.yuzhua.vo.ConsultSessionVo;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * 后台的图文问诊接口，与用户端 {@code /client/consult/**} 是同一套 Service，只是入口不同。
 * 接诊/结束也在这里——会话本身就是状态机，不再挂在预约单的工作台上。
 *
 * 医生账号属于后台登录体系（typ=ADMIN），访问不了 /client/**，所以在这里重开一组。
 *
 * 角色按方法拆开，类上兜底 DOCTOR（新增方法漏标注解时默认只给医生，不会放行给管理员）：
 * - 医生动作（接诊/结束/已读/未读数/我接诊的列表）锁 ROLE_DOCTOR，管理员不参与对话；
 * - 管理员可在后台「问诊记录」里**只读 + 处置**：/page 与 /{id}/messages 对 ADMIN 放行（审计视图，
 *   被屏蔽行不过滤），另有 /message/{msgId}/hidden 与 /{id}/moderate 两个处置口（显式 ADMIN）——
 *   处置只改标志位，不提供发言与标记已读。
 */
@Tag(name = "管理后台-图文问诊")
@RestController
@RequestMapping("/admin/consult")
@RequiredArgsConstructor
@RequireRole(LoginUser.ROLE_DOCTOR)
public class AdminConsultController {

    private final ConsultService consultService;

    @Operation(summary = "我接诊的会话列表（医生）")
    @GetMapping("/sessions")
    @RequireRole(LoginUser.ROLE_DOCTOR)
    public Result<PageResult<ConsultSessionVo>> sessions(ConsultQuery query) {
        return Result.ok(consultService.pageMine(query));
    }

    @GetMapping("/sessions/{id}")
    public Result<ConsultSessionVo> detail(@PathVariable Long id) {
        return Result.ok(consultService.detailMine(id));
    }

    @Operation(summary = "全部会话分页（管理员只读 + 处置视图）")
    @GetMapping("/page")
    @RequireRole(LoginUser.ROLE_ADMIN)
    public Result<PageResult<ConsultSessionVo>> page(ConsultQuery query) {
        return Result.ok(consultService.pageForAdmin(query));
    }

    @Operation(summary = "接诊：待接诊会话转为进行中")
    @PostMapping("/{id}/accept")
    @RequireRole(LoginUser.ROLE_DOCTOR)
    public Result<Void> accept(@PathVariable Long id) {
        consultService.accept(id);
        return Result.ok("已接诊", null);
    }

    @Operation(summary = "结束问诊，可附一段问诊小结（线上只建议、确诊要面诊）")
    @PostMapping("/{id}/close")
    @RequireRole(LoginUser.ROLE_DOCTOR)
    public Result<Void> close(@PathVariable Long id, @RequestBody(required = false) ConsultCloseForm form) {
        consultService.close(id, form == null ? null : form.getSummary());
        return Result.ok("已结束", null);
    }

    @Operation(summary = "会话历史消息，新→旧分页（医生走参与方校验；管理员只读）")
    @GetMapping("/{id}/messages")
    @RequireRole({LoginUser.ROLE_DOCTOR, LoginUser.ROLE_ADMIN})
    public Result<PageResult<ConsultMessage>> messages(@PathVariable Long id, @Valid ConsultMessageQuery query) {
        return Result.ok(consultService.historyForViewer(id, query));
    }

    // 前端已读全走 WS READ 帧；这个 REST 入口留给 tools/audit_regression.mjs
    // 的并发对偶测试（发送/已读、已读/屏蔽两组竞态从这里驱动）
    @Operation(summary = "标记已读（医生）")
    @PostMapping("/{id}/read")
    @RequireRole(LoginUser.ROLE_DOCTOR)
    public Result<Void> read(@PathVariable Long id) {
        consultService.markRead(id);
        return Result.ok("已读", null);
    }

    @Operation(summary = "有未读的会话数（医生）")
    @GetMapping("/unread")
    @RequireRole(LoginUser.ROLE_DOCTOR)
    public Result<Long> unread() {
        return Result.ok(consultService.unreadTotal());
    }

    @Operation(summary = "屏蔽 / 恢复一条消息（仅管理员；被屏蔽内容对参与方不可见，审计视图仍可见）")
    @PutMapping("/message/{msgId}/hidden")
    @RequireRole(LoginUser.ROLE_ADMIN)
    public Result<Void> hideMessage(@PathVariable Long msgId,
                                    @RequestParam Integer hidden,
                                    @RequestParam(required = false) String reason) {
        consultService.changeMessageHidden(msgId, hidden, reason);
        return Result.ok(hidden == 1 ? "已屏蔽" : "已恢复", null);
    }

    @Operation(summary = "处置会话：1 无效关闭 2 违规屏蔽，0 撤销（仅管理员；非 0 会连带关闭会话）")
    @PutMapping("/{id}/moderate")
    @RequireRole(LoginUser.ROLE_ADMIN)
    public Result<Void> moderate(@PathVariable Long id,
                                 @RequestParam Integer moderateStatus,
                                 @RequestParam(required = false) String reason) {
        consultService.moderate(id, moderateStatus, reason);
        return Result.ok(moderateStatus == 0 ? "已撤销处置" : "已处置", null);
    }
}
